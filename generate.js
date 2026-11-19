const fs = require('fs');

// Clés séparées par des virgules, des espaces ou des retours à la ligne
const API_KEYS = (process.env.AGNES_API_KEY || '').split(/[\s,]+/).map(k => k.trim()).filter(Boolean);
const GH_TOKEN = process.env.GH_TOKEN;
const GH_REPO = 'sabrina97490/studio-films-automation';
const STORYBOARD_FILE = './storyboard.json';

if (API_KEYS.length === 0 || !GH_TOKEN) {
    console.error("❌ ERREUR : Clés API ou Token GitHub manquants dans les secrets.");
    process.exit(1);
}

let keyIndex = 0;
function getNextKey() {
    const key = API_KEYS[keyIndex];
    keyIndex = (keyIndex + 1) % API_KEYS.length;
    return key;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Lit la version À JOUR de storyboard.json sur GitHub (l'app a pu la modifier pendant la nuit)
async function fetchRemoteStoryboard() {
    const getRes = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/storyboard.json`, {
        headers: { 'Authorization': `Bearer ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!getRes.ok) throw new Error(`Impossible de lire le fichier sur GitHub (${getRes.status})`);
    const data = await getRes.json();
    const storyboard = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    return { storyboard, sha: data.sha };
}

// Ajoute UNIQUEMENT la vidéo de ce plan dans la version actuelle sur GitHub,
// au lieu de réécrire tout le fichier lu au démarrage (qui écraserait les changements faits depuis l'app).
async function pushToGitHub(ident, videoUrl) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const { storyboard, sha } = await fetchRemoteStoryboard();
            const shot = storyboard.find(s => s.ident === ident);
            if (!shot) {
                console.log(`⚠️ ${ident} n'existe plus sur GitHub : vidéo non enregistrée (${videoUrl}).`);
                return;
            }
            shot.video_url = videoUrl;

            // Utilisation de Buffer pour éviter les bugs d'encodage avec les accents
            const base64Content = Buffer.from(JSON.stringify(storyboard, null, 2), 'utf8').toString('base64');

            const putRes = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/storyboard.json`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${GH_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github.v3+json' },
                body: JSON.stringify({ message: `🤖 Vidéo générée (${ident})`, content: base64Content, sha })
            });
            if (putRes.ok) { console.log(`✅ ${ident} synchronisé sur GitHub !`); return; }
            // 409/422 : le fichier a changé entre la lecture et l'écriture (envoi depuis l'app) → on relit
            if (putRes.status !== 409 && putRes.status !== 422) throw new Error(`Erreur lors de l'envoi sur GitHub (${putRes.status})`);
            console.log(`   Fichier modifié entre-temps, nouvel essai (${attempt}/3)...`);
            await sleep(2000);
        } catch (e) {
            console.error(`⚠️ Erreur de synchronisation GitHub : ${e.message}`);
            await sleep(2000);
        }
    }
    console.error(`❌ ${ident} : vidéo générée mais non enregistrée sur GitHub. URL à noter : ${videoUrl}`);
}

async function generateVideoWithRetry(shot) {
    console.log(`\n--- Génération pour ${shot.ident} ---`);
    let videoId = null;
    
    // Augmentation à 15 essais avec attente progressive pour contrer la file d'attente
    for (let attempt = 1; attempt <= 15; attempt++) {
        const currentKey = getNextKey();
        try {
            const response = await fetch('https://apihub.agnes-ai.com/v1/videos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentKey}` },
                body: JSON.stringify({
                    model: 'agnes-video-2.5-flash',
                    prompt: shot.anim_prompt || shot.script || 'Cinematic motion',
                    first_frame: shot.images[0].url,
                    seconds: '5', mode: 'keyframe', size: '720P'
                })
            });
            const textResponse = await response.text();
            let data; try { data = JSON.parse(textResponse); } catch(e) { data = {}; }
            
            if (response.ok && data.video_id) { 
                videoId = data.video_id; 
                break; 
            }
            
            if (data.code === 'video_queue_full' || response.status === 429) {
                // Attente exponentielle : commence à 30s et augmente jusqu'à 3 minutes max
                const waitTime = Math.min(30000 + (attempt * 10000), 180000);
                console.log(`⏳ File pleine (essai ${attempt}/15), attente ${waitTime / 1000}s...`);
                await sleep(waitTime); 
            } else {
                console.log(`⚠️ Erreur API (${response.status}), attente 15s...`);
                await sleep(15000); 
            }
        } catch (e) { 
            console.log(`⚠️ Erreur réseau, attente 15s...`);
            await sleep(15000); 
        }
    }
    
    if (!videoId) {
        console.log(`⚠️ Impossible de générer ${shot.ident} après 15 essais. On passe au suivant.`);
        return null;
    }

    console.log(`⏳ Suivi de la vidéo pour ${shot.ident} (ID: ${videoId})...`);
    const startTime = Date.now();
    
    // Timeout porté à 20 minutes pour être sûr d'avoir le résultat
    while (Date.now() - startTime < 1200000) { 
        // On attend 10 secondes au lieu de 5 pour éviter de se faire bloquer par l'API de statut
        await sleep(10000); 
        const currentKey = getNextKey(); 
        try {
            const statusResponse = await fetch(`https://apihub.agnes-ai.com/agnesapi?video_id=${videoId}&model_name=agnes-video-2.5-flash`, { headers: { 'Authorization': `Bearer ${currentKey}` } });
            const statusData = await statusResponse.json();
            
            // Extraction robuste du statut (gère les réponses imbriquées)
            const currentStatus = statusData.status || (statusData.data && statusData.data.status) || statusData.task_status;
            
            if (currentStatus !== undefined) {
                console.log(`   Statut : ${currentStatus}`);
            }
            
            if (currentStatus === 'completed') {
                // Extraction robuste de l'URL
                const url = statusData.video_url || statusData.url || (statusData.data && statusData.data.video_url) || (statusData.data && statusData.data.url);
                if (!url) console.log(`   ⚠️ Terminé mais URL introuvable : ${JSON.stringify(statusData).slice(0, 300)}`);
                return url || null;
            }
            if (currentStatus === 'failed') {
                console.log(`   ❌ Échec de la génération par l'API.`);
                return null;
            }
        } catch(e) {
            // On ignore silencieusement les erreurs de réseau pendant le polling
        }
    }
    console.log(`   ⚠️ Timeout (20min) pour ${shot.ident}.`);
    return null;
}

(async () => {
    let storyboard = JSON.parse(fs.readFileSync(STORYBOARD_FILE, 'utf8'));
    const toGen = storyboard.filter(shot => shot.images && shot.images.length > 0 && !shot.video_url);

    if (toGen.length === 0) return console.log('✅ Tout est déjà généré.');

    console.log(`🎬 ${toGen.length} plan(s) à traiter.`);
    
    for (const queued of toGen) {
        try {
            // Avant chaque plan, on reprend sa version actuelle sur GitHub :
            // prompt/image modifiés depuis l'app, plan supprimé ou vidéo déjà faite.
            let shot = queued;
            try {
                const { storyboard: latest } = await fetchRemoteStoryboard();
                const fresh = latest.find(s => s.ident === queued.ident);
                if (!fresh) { console.log(`\n⏭️ ${queued.ident} supprimé depuis l'app, ignoré.`); continue; }
                if (fresh.video_url) { console.log(`\n⏭️ ${queued.ident} a déjà une vidéo, ignoré.`); continue; }
                if (!fresh.images || !fresh.images.length) { console.log(`\n⏭️ ${queued.ident} n'a plus d'image, ignoré.`); continue; }
                shot = fresh;
            } catch (e) {
                console.log(`⚠️ Lecture GitHub impossible (${e.message}), on utilise la version du démarrage.`);
            }

            const url = await generateVideoWithRetry(shot);
            if (url) {
                queued.video_url = url;
                fs.writeFileSync(STORYBOARD_FILE, JSON.stringify(storyboard, null, 2));
                console.log(`💾 ${shot.ident} sauvegardé localement.`);
                await pushToGitHub(shot.ident, url);
            }
        } catch (error) {
            console.error(`❌ Erreur pour ${shot.ident}: ${error.message}`);
        }
    }
    console.log("🏁 Fin de la session.");
})();

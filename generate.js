const fs = require('fs');

const API_KEYS = (process.env.AGNES_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
const GH_TOKEN = process.env.GH_TOKEN;
const GH_REPO = 'sabrina97490/studio-films-automation'; // Ton dépôt
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

async function pushToGitHub(storyboard) {
    try {
        const jsonContent = JSON.stringify(storyboard, null, 2);
        const getRes = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/storyboard.json`, {
            headers: { 'Authorization': `Bearer ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!getRes.ok) throw new Error("Impossible de lire le fichier sur GitHub");
        const data = await getRes.json();
        const sha = data.sha;
        const base64Content = btoa(unescape(encodeURIComponent(jsonContent)));
        const putRes = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/storyboard.json`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${GH_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github.v3+json' },
            body: JSON.stringify({ message: '🤖 Vidéo générée', content: base64Content, sha: sha })
        });
        if (!putRes.ok) throw new Error("Erreur lors de l'envoi sur GitHub");
        console.log(`✅ Fichier storyboard.json synchronisé sur GitHub !`);
    } catch (e) {
        console.error(`⚠️ Erreur de synchronisation GitHub : ${e.message}`);
    }
}

async function generateVideoWithRetry(shot) {
    console.log(`\n--- Génération pour ${shot.ident} ---`);
    let videoId = null;
    
    // ON REPASSE À 8 ESSAIS (environ 6 minutes d'attente max par plan)
    for (let attempt = 1; attempt <= 8; attempt++) {
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
                console.log(`⏳ File pleine (essai ${attempt}/8), attente 45s...`);
                await sleep(45000); 
            } else {
                console.log(`⚠️ Erreur API, attente 10s...`);
                await sleep(10000); 
            }
        } catch (e) { 
            console.log(`⚠️ Erreur réseau, attente 15s...`);
            await sleep(15000); 
        }
    }
    
    if (!videoId) {
        console.log(`⚠️ Impossible de générer ${shot.ident} après 8 essais. On passe au suivant.`);
        return null;
    }

    console.log(`⏳ Suivi de la vidéo pour ${shot.ident}...`);
    const startTime = Date.now();
    while (Date.now() - startTime < 900000) { 
        await sleep(5000); 
        const currentKey = getNextKey(); 
        try {
            const statusResponse = await fetch(`https://apihub.agnes-ai.com/agnesapi?video_id=${videoId}&model_name=agnes-video-2.5-flash`, { headers: { 'Authorization': `Bearer ${currentKey}` } });
            const statusData = await statusResponse.json();
            console.log(`   Statut : ${statusData.status}`);
            
            if (statusData.status === 'completed') {
                return statusData.video_url || statusData.url;
            }
            if (statusData.status === 'failed') return null;
        } catch(e) {}
    }
    return null;
}

(async () => {
    let storyboard = JSON.parse(fs.readFileSync(STORYBOARD_FILE, 'utf8'));
    const toGen = storyboard.filter(shot => shot.images && shot.images.length > 0 && !shot.video_url);

    if (toGen.length === 0) return console.log('✅ Tout est déjà généré.');

    console.log(`🎬 ${toGen.length} plan(s) à traiter.`);
    
    for (const shot of toGen) {
        try {
            const url = await generateVideoWithRetry(shot);
            if (url) {
                shot.video_url = url;
                fs.writeFileSync(STORYBOARD_FILE, JSON.stringify(storyboard, null, 2));
                console.log(`💾 ${shot.ident} sauvegardé.`);
                await pushToGitHub(storyboard);
            }
        } catch (error) {
            console.error(`❌ Erreur pour ${shot.ident}: ${error.message}`);
        }
    }
    console.log("🏁 Fin de la session.");
})();

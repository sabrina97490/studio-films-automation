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
    // On réduit à 3 essais pour ne pas perdre 10 minutes par plan si c'est saturé
    for (let attempt = 0; attempt < 3; attempt++) {
        const currentKey = getNextKey();
        try {
            const response = await fetch('https://apihub.agnes-ai.com/v1/videos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentKey}` },
                body: JSON.stringify({
                    model: 'agnes-video-2.5-flash',
                    prompt: shot.anim_prompt || 'Cinematic motion',
                    first_frame: shot.images[0].url,
                    seconds: '5', mode: 'keyframe', size: '720P'
                })
            });
            const textResponse = await response.text();
            let data; try { data = JSON.parse(textResponse); } catch(e) { data = {}; }
            if (response.ok && data.video_id) { videoId = data.video_id; break; }
            if (data.code === 'video_queue_full' || response.status === 429) {
                console.log(`⏳ File pleine, on réessaie dans 30s...`);
                await sleep(30000); 
            } else {
                await sleep(5000); 
            }
        } catch (e) { await sleep(5000); }
    }
    
    if (!videoId) {
        console.log(`⚠️ File saturée pour ${shot.ident}, on passe au suivant.`);
        return null; // On renvoie null pour dire "échec, mais on continue"
    }

    console.log(`⏳ Suivi de la vidéo pour ${shot.ident}...`);
    const startTime = Date.now();
    while (Date.now() - startTime < 900000) { 
        await sleep(5000); 
        const currentKey = getNextKey(); 
        try {
            const statusResponse = await fetch(`https://apihub.agnes-ai.com/agnesapi?video_id=${videoId}&model_name=agnes-video-2.5-flash`, { headers: { 'Authorization': `Bearer ${currentKey}` } });
            const statusData = await statusResponse.json();
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

const fs = require('fs');

const API_KEYS = (process.env.AGNES_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
const STORYBOARD_FILE = './storyboard.json';

if (API_KEYS.length === 0) {
    console.error("❌ ERREUR : Aucune clé API trouvée dans les secrets GitHub.");
    process.exit(1);
}

let keyIndex = 0;
function getNextKey() {
    const key = API_KEYS[keyIndex];
    keyIndex = (keyIndex + 1) % API_KEYS.length;
    return key;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function generateVideoWithRetry(shot) {
    console.log(`\n--- Début de la génération pour le plan ${shot.ident} ---`);

    let videoId = null;
    for (let attempt = 0; attempt < 15; attempt++) {
        const currentKey = getNextKey();
        try {
            const response = await fetch('https://apihub.agnes-ai.com/v1/videos', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentKey}`
                },
                body: JSON.stringify({
                    model: 'agnes-video-2.5-flash',
                    prompt: shot.anim_prompt || 'Cinematic motion',
                    first_frame: shot.images[0].url,
                    seconds: '5',
                    mode: 'keyframe',
                    size: '720P'
                })
            });

            const textResponse = await response.text();
            let data;
            try { data = JSON.parse(textResponse); } catch(e) { data = {}; }

            if (response.ok && data.video_id) {
                videoId = data.video_id;
                break; 
            }

            if (data.code === 'video_queue_full' || response.status === 429) {
                console.log(`⏳ File pleine (essai ${attempt + 1}/15). Attente 45s...`);
                await sleep(45000); 
            } else {
                console.log(`⚠️ Erreur API : ${data.message || textResponse}. Attente 10s...`);
                await sleep(10000); 
            }
        } catch (e) {
            console.error(`⚠️ Erreur réseau (essai ${attempt + 1}/15) : ${e.message}`);
            await sleep(15000);
        }
    }

    if (!videoId) throw new Error('Impossible de créer la tâche après 15 essais.');

    console.log(`⏳ Suivi de la vidéo en cours...`);
    const startTime = Date.now();
    
    while (Date.now() - startTime < 900000) { 
        await sleep(5000); 
        const currentKey = getNextKey(); 
        try {
            const statusResponse = await fetch(
                `https://apihub.agnes-ai.com/agnesapi?video_id=${videoId}&model_name=agnes-video-2.5-flash`,
                { headers: { 'Authorization': `Bearer ${currentKey}` } }
            );
            const statusData = await statusResponse.json();
            
            console.log(`   Statut : ${statusData.status}`);

            if (statusData.status === 'completed') {
                // Récupération de l'URL selon le format de retour (url ou video_url)
                const finalUrl = statusData.video_url || statusData.url || (statusData.data && statusData.data[0] && statusData.data[0].url);
                if(!finalUrl) throw new Error("L'API n'a pas renvoyé d'URL vidéo.");
                console.log(`🎉 Vidéo prête pour ${shot.ident} !`);
                return finalUrl;
            }
            if (statusData.status === 'failed') {
                throw new Error(`Échec de la génération.`);
            }
        } catch(e) {
            console.log(`   (Erreur de suivi, on réessaie... ${e.message})`);
        }
    }
    throw new Error('Timeout (15 minutes).');
}

(async () => {
    console.log("📖 Lecture du fichier storyboard.json...");
    let storyboard;
    try {
        const fileContent = fs.readFileSync(STORYBOARD_FILE, 'utf8');
        storyboard = JSON.parse(fileContent);
    } catch (e) {
        console.error("❌ ERREUR FATALE : Impossible de lire storyboard.json.", e.message);
        process.exit(1);
    }

    if (!Array.isArray(storyboard)) {
        console.error("❌ ERREUR : storyboard.json doit être un tableau.");
        process.exit(1);
    }

    // On ne prend QUE les plans qui ont une image et qui n'ont PAS encore de vidéo
    const toGen = storyboard.filter(shot => shot.images && shot.images.length > 0 && !shot.video_url);

    if (toGen.length === 0) {
        console.log('✅ Tous les plans ont déjà une vidéo. Rien à faire.');
        return;
    }

    console.log(`🎬 ${toGen.length} plan(s) à générer.`);
    
    for (const shot of toGen) {
        try {
            const url = await generateVideoWithRetry(shot);
            shot.video_url = url;
            
            // Sauvegarde locale sur le serveur GitHub
            fs.writeFileSync(STORYBOARD_FILE, JSON.stringify(storyboard, null, 2));
            console.log(`💾 Sauvegarde locale réussie pour ${shot.ident}.`);
            
        } catch (error) {
            console.error(`❌ Échec définitif pour le plan ${shot.ident}: ${error.message}`);
        }
    }
    
    console.log('\n🏁 Travail terminé pour cette session.');
})();

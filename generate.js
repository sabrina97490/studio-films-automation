const fs = require('fs');

// On récupère les 3 clés (séparées par des virgules) et on nettoie les espaces
const API_KEYS = (process.env.AGNES_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
const STORYBOARD_FILE = './storyboard.json';

if (API_KEYS.length === 0) {
    console.error("❌ ERREUR : Aucune clé API trouvée dans les secrets GitHub.");
    process.exit(1);
}

let keyIndex = 0;
function getNextKey() {
    if (API_KEYS.length === 0) throw new Error("Aucune clé API disponible.");
    const key = API_KEYS[keyIndex];
    keyIndex = (keyIndex + 1) % API_KEYS.length;
    return key;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function generateVideoWithRetry(shot) {
    console.log(`Début de la génération pour le plan ${shot.ident}...`);

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
                    prompt: shot.anim_prompt || 'Cinematic motion, smooth camera',
                    first_frame: shot.images[0].url,
                    seconds: '5',
                    mode: 'keyframe',
                    size: '720P'
                })
            });

            const data = await response.json();

            if (response.ok && data.video_id) {
                videoId = data.video_id;
                break; 
            }

            if (data.code === 'video_queue_full' || response.status === 429) {
                console.log(`File pleine (essai ${attempt + 1}/15). Attente 45s et changement de clé...`);
                await sleep(45000); 
            } else {
                console.log(`Erreur API : ${data.message || 'Inconnue'}. On change de clé...`);
                await sleep(10000); 
            }
        } catch (e) {
            console.error('Erreur réseau, nouvel essai dans 15s…', e.message);
            await sleep(15000);
        }
    }

    if (!videoId) throw new Error('Impossible de créer la tâche après 15 essais.');

    console.log(`Tâche créée (ID: ${videoId}). Suivi en cours...`);
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
            
            console.log(`Statut pour ${shot.ident}: ${statusData.status}`);

            if (statusData.status === 'completed') {
                console.log(`✅ Vidéo prête pour ${shot.ident} : ${statusData.url}`);
                return statusData.url;
            }
            if (statusData.status === 'failed') {
                throw new Error(`La génération a échoué pour le plan ${shot.ident}`);
            }
        } catch(e) {
            console.log("Erreur de suivi, on réessaie...");
        }
    }
    throw new Error('Timeout lors de l\'attente de la vidéo.');
}

(async () => {
    let storyboard = JSON.parse(fs.readFileSync(STORYBOARD_FILE, 'utf8'));

    const shotsToGenerate = storyboard.filter(shot => 
        shot.images && shot.images.length > 0 && !shot.video_url
    );

    if (shotsToGenerate.length === 0) {
        console.log('Tous les plans ont déjà une vidéo. Rien à faire.');
        return;
    }

    console.log(`${shotsToGenerate.length} plan(s) à générer avec ${API_KEYS.length} clé(s) API.`);
    
    for (const shot of shotsToGenerate) {
        try {
            const videoUrl = await generateVideoWithRetry(shot);
            shot.video_url = videoUrl;
            fs.writeFileSync(STORYBOARD_FILE, JSON.stringify(storyboard, null, 2));
            console.log(`Sauvegarde effectuée pour ${shot.ident}.`);
        } catch (error) {
            console.error(`❌ Échec pour le plan ${shot.ident}: ${error.message}`);
        }
    }
    
    console.log('Travail terminé pour cette session.');
})();

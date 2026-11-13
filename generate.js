async function generateWithRetry(prompt, imageUrl, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch('https://apihub.agnes-ai.com/v1/videos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.AGNES_API_KEY}`
        },
        body: JSON.stringify({
          model: 'agnes-video-2.5-flash',
          prompt: prompt,
          first_frame: imageUrl,
          seconds: '5',
          mode: 'keyframe',
          size: '720P'
        })
      });
      const data = await response.json();
      if (data.video_id) return data.video_id;
      // Si file pleine ou rate limit, on attend et on réessaie
      console.log('File pleine, attente de 60s…');
      await new Promise(r => setTimeout(r, 60000));
    } catch (e) {
      console.error('Erreur, nouvel essai dans 30s…', e.message);
      await new Promise(r => setTimeout(r, 30000));
    }
  }
  throw new Error('Échec après plusieurs tentatives');
}
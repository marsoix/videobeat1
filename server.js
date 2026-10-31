const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const cheerio = require('cheerio');
const ffmpegPath = require('ffmpeg-static');
const { spawnSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function sanitizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function toArray(value) {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter(Boolean)
    .map((v) => sanitizeText(v))
    .filter(Boolean);
}

function extractBeatstarsMeta(html) {
  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('h1').first().text() ||
    'Beat sin título';

  const artist =
    $('[data-test="producer-name"], .producer-name, .artist-name, .user-name').first().text() ||
    $('meta[property="music:musician"]').attr('content') ||
    'Artista desconocido';

  const coverUrl =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('img').first().attr('src') ||
    'https://images.unsplash.com/photo-1501386761578-eac5c94b800a';

  const audioUrl =
    $('meta[property="og:audio"]').attr('content') ||
    $('meta[name="twitter:audio"]').attr('content') ||
    $('audio source').first().attr('src') ||
    $('source[type="audio/mpeg"]').first().attr('src') ||
    $('source[type^="audio/"]').first().attr('src') ||
    '';

  let tags = [];
  const metaKeywords = $('meta[name="keywords"]').attr('content');
  if (metaKeywords) tags = tags.concat(metaKeywords.split(',').map((v) => sanitizeText(v)));

  $('meta[property="article:tag"]').each((_, el) => {
    const val = $(el).attr('content');
    if (val) tags.push(val);
  });

  const scriptJson = $('script[type="application/ld+json"]').toArray();
  scriptJson.forEach((item) => {
    try {
      const raw = $(item).html();
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const walk = (value) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) value.forEach(walk);
        if (value.keywords) {
          value.keywords.split(',').forEach((k) => tags.push(k.trim()));
        }
        if (value.genre) tags.push(String(value.genre));
        for (const k in value) {
          if (typeof value[k] === 'object') walk(value[k]);
        }
      };
      walk(parsed);
    } catch (e) {
      // ignore
    }
  });

  const keywords = Array.from(
    new Set(
      toArray(tags)
        .map((t) => t.replace(/["']/g, '').trim())
        .filter((t) => t.length > 1)
        .map((t) => t.split(/\\s*[,|/]+\\s*/).filter(Boolean))
        .flat()
    )
  ).slice(0, 15);

  return {
    title: sanitizeText(title),
    artist: sanitizeText(artist),
    coverUrl,
    audioUrl,
    tags: Array.from(new Set(keywords)).slice(0, 10),
    keywords: Array.from(new Set(keywords)).slice(0, 10)
  };
}

async function fetchBeatData(beatstarsUrl) {
  const response = await axios.get(beatstarsUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
    },
    timeout: 20000
  });

  const metadata = extractBeatstarsMeta(response.data);

  return {
    ...metadata,
    beatstarsUrl: beatstarsUrl,
    source: 'BeatStars',
    audioUrl:
      metadata.audioUrl ||
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'
  };
}

function downloadFile(url, destination) {
  return axios({
    url,
    method: 'GET',
    responseType: 'arraybuffer',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
    }
  }).then((response) => {
    fs.writeFileSync(destination, response.data);
  });
}

app.post('/api/analyze-beat', async (req, res) => {
  try {
    const { beatstarsUrl } = req.body || {};
    if (!beatstarsUrl) {
      return res.status(400).json({ error: 'Falta beatstarsUrl' });
    }

    const beat = await fetchBeatData(beatstarsUrl);
    res.json(beat);
  } catch (error) {
    console.error('Error en /api/analyze-beat:', error.message);
    res.status(500).json({
      error: 'No se pudo analizar la URL de BeatStars.',
      details: error.message
    });
  }
});

app.post('/api/render-video', async (req, res) => {
  try {
    const {
      audioUrl,
      coverUrl,
      title = 'beat',
      artist = 'artist',
      beatstarsUrl = '',
      duration = 30,
      orientation = 'vertical'
    } = req.body || {};

    if (!audioUrl || !coverUrl) {
      return res.status(400).send('Se requieren audioUrl y coverUrl.');
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatvideo-'));
    const mp3Path = path.join(workDir, 'audio.mp3');
    const coverPath = path.join(workDir, 'cover.jpg');
    const outputPath = path.join(workDir, 'render.mp4');

    await downloadFile(audioUrl, mp3Path);
    await downloadFile(coverUrl, coverPath);

    const screen = orientation === 'vertical' ? '720:1280' : '1280:720';
    const durationValue = duration === 'full' ? '0' : String(duration);

    const ffmpegArgs = [
      '-loop',
      '1',
      '-framerate',
      '1',
      '-i',
      coverPath,
      '-i',
      mp3Path,
      '-t',
      durationValue === '0' ? '3600' : durationValue,
      '-vf',
      `scale=${screen}:force_original_aspect_ratio=decrease,pad=${screen}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-shortest',
      '-movflags',
      '+faststart',
      outputPath
    ];

    const result = spawnSync(ffmpegPath, ffmpegArgs, {
      stdio: 'inherit'
    });

    if (result.status !== 0) {
      throw new Error('FFmpeg falló al renderizar el video.');
    }

    const file = fs.readFileSync(outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${(title || 'beat').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${orientation}.mp4"`
    );
    res.send(file);
  } catch (error) {
    console.error('Error en /api/render-video:', error.message);
    res.status(500).send(error.message || 'No se pudo renderizar el video.');
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'running' });
});

app.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
});
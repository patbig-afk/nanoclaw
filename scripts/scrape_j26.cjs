/**
 * Scrape Jour 26 - Webdesign courses from learning.cube.fr
 * 1. Playwright extracts Vimeo IDs + h-token from iframes
 * 2. yt-dlp downloads audio
 * 3. Whisper API transcribes
 * 4. Saves .md transcripts to groups/telegram_cube-bootcamp/Cours/Webdesign/
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const https = require('https');

const EMAIL = 'patbig@gmail.com';
const PASSWORD = '!Internet1708';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const OUTPUT_DIR = path.join(
  __dirname,
  '../groups/telegram_cube-bootcamp/Cours/Webdesign'
);
const TMP_DIR = '/tmp/cube_j26';

const LESSONS = [
  {
    slug: '01-decouvrir-le-webdesign',
    url: 'https://learning.cube.fr/course/decouvrir-le-webdesign?course=1726239616737x133502646706004750&section=1765983212049x538851617032623170',
    title: '1. Découvrir le webdesign',
  },
  {
    slug: '02-structurer-un-projet',
    url: 'https://learning.cube.fr/course/structurer-un-projet?course=1726239616737x133502646706004750',
    title: '2. Structurer un projet',
  },
  {
    slug: '03-organiser-visuellement-une-page',
    url: 'https://learning.cube.fr/course/organiser-visuellement-une-page?course=1726239616737x133502646706004750',
    title: '3. Organiser visuellement une page',
  },
  {
    slug: '04-saisir-une-donnee',
    url: 'https://learning.cube.fr/course/saisir-une-donnee?course=1726239616737x133502646706004750',
    title: '4. Saisir une donnée',
  },
  {
    slug: '05-afficher-les-images',
    url: 'https://learning.cube.fr/course/afficher-les-images?course=1726239616737x133502646706004750',
    title: '5. Afficher les images',
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getVimeoEmbedUrls(page) {
  const urls = new Set();
  // From loaded frames
  for (const frame of page.frames()) {
    const u = frame.url();
    if (u.includes('player.vimeo.com/video/')) urls.add(u);
  }
  // From iframe DOM attributes
  const srcs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('iframe'))
      .map((f) => f.src || f.getAttribute('src') || '')
      .filter((s) => s.includes('vimeo'))
  );
  for (const s of srcs) urls.add(s);
  return [...urls];
}

function parseVimeoUrl(embedUrl) {
  const idMatch = embedUrl.match(/player\.vimeo\.com\/video\/(\d+)/);
  const hMatch = embedUrl.match(/[?&]h=([a-f0-9]+)/);
  return {
    id: idMatch ? idMatch[1] : null,
    h: hMatch ? hMatch[1] : null,
    full: embedUrl,
  };
}

function whisperTranscribe(audioPath) {
  if (!OPENAI_API_KEY) {
    console.log('  ⚠️  OPENAI_API_KEY not set — skipping Whisper');
    return null;
  }
  const stats = fs.statSync(audioPath);
  const sizeMB = stats.size / (1024 * 1024);
  console.log(`  Transcribing ${path.basename(audioPath)} (${sizeMB.toFixed(1)} MB)...`);

  // Split if > 24 MB
  let filesToTranscribe = [audioPath];
  if (sizeMB > 24) {
    console.log('  File too large — splitting with ffmpeg...');
    const base = audioPath.replace(/\.[^.]+$/, '');
    execSync(
      `ffmpeg -i "${audioPath}" -f segment -segment_time 600 -c copy "${base}_part_%03d.mp3" -y`,
      { stdio: 'pipe' }
    );
    filesToTranscribe = fs
      .readdirSync(path.dirname(audioPath))
      .filter((f) => f.startsWith(path.basename(base) + '_part_'))
      .sort()
      .map((f) => path.join(path.dirname(audioPath), f));
  }

  const parts = [];
  for (const f of filesToTranscribe) {
    const result = spawnSync(
      'curl',
      [
        'https://api.openai.com/v1/audio/transcriptions',
        '-H', `Authorization: Bearer ${OPENAI_API_KEY}`,
        '-F', `file=@${f}`,
        '-F', 'model=whisper-1',
        '-F', 'language=fr',
        '-F', 'response_format=text',
      ],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    if (result.status !== 0) {
      console.log(`  Whisper error: ${result.stderr}`);
    } else {
      parts.push(result.stdout.trim());
    }
  }
  return parts.join('\n\n') || null;
}

function ytDlpDownload(vimeo, outputPath) {
  const url = `https://player.vimeo.com/video/${vimeo.id}${vimeo.h ? `?h=${vimeo.h}` : ''}`;
  console.log(`  yt-dlp: ${url}`);
  const result = spawnSync(
    'yt-dlp',
    [
      url,
      '--add-header', 'Referer:https://learning.cube.fr/',
      '-x', '--audio-format', 'mp3',
      '-o', outputPath,
      '--no-playlist',
      '-q',
    ],
    { encoding: 'utf8', timeout: 120000 }
  );
  if (result.status !== 0) {
    console.log(`  yt-dlp stderr: ${result.stderr?.slice(0, 300)}`);
    return false;
  }
  return fs.existsSync(outputPath);
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  console.log(`Output dir: ${OUTPUT_DIR}\n`);

  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Login
  console.log('Logging in...');
  await page.goto('https://learning.cube.fr/welcome', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  await page.waitForTimeout(2000);
  const inputs = await page.$$('input');
  if (inputs.length >= 2) {
    await inputs[0].fill(EMAIL);
    await inputs[1].fill(PASSWORD);
    await inputs[1].press('Enter');
    await page.waitForTimeout(5000);
  }
  console.log('Logged in. URL:', page.url());

  // Collect all Vimeo embed URLs per lesson
  const lessonVimeos = {}; // slug → [{id, h, full}]

  for (const lesson of LESSONS) {
    console.log(`\n=== ${lesson.title} ===`);
    await page.goto(lesson.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(4000);

    let embedUrls = await getVimeoEmbedUrls(page);

    // If nothing loaded, try clicking the first lesson item in the sidebar
    if (embedUrls.length === 0) {
      console.log('  No iframes yet — clicking first lesson item...');
      try {
        const items = await page.$$('[class*="lesson"], [class*="item"], [class*="row"], li');
        for (const item of items.slice(0, 10)) {
          await item.click({ force: true }).catch(() => {});
          await page.waitForTimeout(3000);
          embedUrls = await getVimeoEmbedUrls(page);
          if (embedUrls.length > 0) break;
        }
      } catch (e) {}
    }

    // Still nothing — try scrolling table of contents into view
    if (embedUrls.length === 0) {
      console.log('  Still none — trying scroll + wait...');
      await page.evaluate(() => window.scrollTo(0, 400));
      await page.waitForTimeout(3000);
      embedUrls = await getVimeoEmbedUrls(page);
    }

    const vimeos = embedUrls.map(parseVimeoUrl).filter((v) => v.id);
    console.log(`  Vimeo IDs: ${vimeos.map((v) => v.id).join(', ') || 'none found'}`);
    lessonVimeos[lesson.slug] = vimeos;
  }

  await browser.close();

  // ── Download + transcribe ──────────────────────────────────────────────────
  for (const lesson of LESSONS) {
    console.log(`\n=== Processing: ${lesson.title} ===`);
    const vimeos = lessonVimeos[lesson.slug] || [];
    const transcripts = [];

    for (const vimeo of vimeos) {
      const audioPath = path.join(TMP_DIR, `${lesson.slug}_${vimeo.id}.mp3`);

      if (fs.existsSync(audioPath)) {
        console.log(`  Audio already exists: ${audioPath}`);
      } else {
        const ok = ytDlpDownload(vimeo, audioPath);
        if (!ok) {
          console.log(`  ⚠️  yt-dlp failed for ${vimeo.id}`);
          continue;
        }
      }

      const text = whisperTranscribe(audioPath);
      if (text) {
        transcripts.push({ id: vimeo.id, text });
        console.log(`  ✅ Transcript: ${text.slice(0, 80)}...`);
      }
    }

    // Write markdown file
    const filename = path.join(OUTPUT_DIR, `${lesson.title}.md`);
    let body = '';
    if (transcripts.length > 0) {
      body = transcripts
        .map((t) => `### Vidéo ${t.id}\n\n${t.text}`)
        .join('\n\n---\n\n');
    } else if (vimeos.length > 0) {
      body = `_Transcription en attente — IDs Vimeo : ${vimeos.map((v) => v.id).join(', ')}_\n\nLancer dans le container :\n\`\`\`bash\n${vimeos.map((v) => `yt-dlp "https://player.vimeo.com/video/${v.id}" --add-header "Referer:https://learning.cube.fr/" -x --audio-format mp3 -o audio_${v.id}.mp3`).join('\n')}\n\`\`\``;
    } else {
      body = '_IDs Vimeo non extraits — naviguer manuellement sur la page du cours._';
    }

    const content = [
      `# ${lesson.title}`,
      '',
      `**Source :** ${lesson.url}`,
      `**Vimeo IDs :** ${vimeos.map((v) => v.id).join(', ') || '—'}`,
      '',
      '## Transcript',
      '',
      body,
    ].join('\n');

    fs.writeFileSync(filename, content, 'utf8');
    console.log(`  ✅ Saved: ${filename}`);
  }

  // ── Résumé ─────────────────────────────────────────────────────────────────
  console.log('\n=== RÉSUMÉ FINAL ===');
  for (const lesson of LESSONS) {
    const vimeos = lessonVimeos[lesson.slug] || [];
    const mdPath = path.join(OUTPUT_DIR, `${lesson.title}.md`);
    const hasTranscript = fs.existsSync(mdPath) &&
      !fs.readFileSync(mdPath, 'utf8').includes('Transcription en attente');
    const icon = hasTranscript ? '✅' : vimeos.length > 0 ? '⚠️ ' : '❌';
    console.log(`${icon} ${lesson.title} | IDs: ${vimeos.map((v) => v.id).join(', ') || '—'}`);
  }
  console.log(`\nFichiers dans: ${OUTPUT_DIR}`);
})();

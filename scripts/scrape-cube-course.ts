#!/usr/bin/env npx tsx
/**
 * Scrape all sections of a Cube course via Bubble API.
 * Downloads VTT transcripts (→ markdown) and MP3 audio.
 * Usage: npx tsx scripts/scrape-cube-course.ts <course-id> <real-course-id> <output-dir>
 *
 * course-id      : ID used in URL param "course=" (enrollment record)
 * real-course-id : ID of the Course object returned by the section API
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REAL_COURSE_ID = process.argv[2] || '1735634516373x640757767213201900';
const OUTPUT_DIR     = process.argv[3] || path.join(__dirname, '../groups/telegram_cube-bootcamp/Cours/Bubble/transcripts_jour45');
const COOKIES_FILE   = path.join(__dirname, '../groups/telegram_cube-bootcamp/Cours/cookies.txt');
const BASE_URL       = 'https://learning.cube.fr';
const COOKIE_HDR     = 'cube-ecole_live_u2main=bus|1766692836149x451270478509395500|1772746127538x433681696241999800; cube-ecole_live_u2main.sig=XxhovpFYLwhVCvszNmR0-aW9678';

function get(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { Cookie: COOKIE_HDR, Accept: 'application/json' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function vttToMarkdown(vtt: string, title: string): string {
  const lines = vtt.split('\n');
  const textLines: string[] = [];
  for (const line of lines) {
    // Skip WEBVTT header, cue numbers (pure digits), timestamps, and empty lines
    if (!line.trim() || line.startsWith('WEBVTT') || /^\d+$/.test(line.trim()) || line.includes('-->')) continue;
    textLines.push(line.trim());
  }
  // Merge consecutive lines and deduplicate consecutive identical segments
  const merged = textLines.join(' ').replace(/\s+/g, ' ');
  return `# ${title}\n\n${merged}\n`;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location!, dest).then(resolve).catch(reject);
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    req.on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 1. Lister toutes les sections du cours
  const constraint = encodeURIComponent(JSON.stringify([{ key: 'Course', constraint_type: 'equals', value: REAL_COURSE_ID }]));
  const sectionsRaw = await get(`${BASE_URL}/api/1.1/obj/section?limit=50&constraints=${constraint}&sort_field=Order`);
  const { response } = JSON.parse(sectionsRaw);
  const sections: any[] = response.results;

  console.log(`${sections.length} sections trouvées pour le cours ${REAL_COURSE_ID}\n`);

  for (const section of sections) {
    if (section.Type !== 'Lesson') {
      console.log(`[${section.Order}] ${section.Type} "${section.Title || '(sans titre)'}" — ignoré`);
      continue;
    }

    console.log(`\n[${section.Order}] Leçon: ${section.Title}`);

    const blocs: string[] = section.SectionBlocs || [];
    let videoBloc: any = null;

    for (const blocId of blocs) {
      const blocRaw = await get(`${BASE_URL}/api/1.1/obj/sectionbloc/${blocId}`);
      const bloc = JSON.parse(blocRaw).response;
      if (bloc?.Type === 'Video' && bloc?.VideoID_DM) {
        videoBloc = bloc;
        break;
      }
    }

    if (!videoBloc) {
      console.log('  — Pas de vidéo Dailymotion dans cette section');
      continue;
    }

    const videoId = videoBloc.VideoID_DM;
    const vttUrl  = videoBloc.VideoTranscript ? `https:${videoBloc.VideoTranscript}` : null;
    console.log(`  ID Dailymotion: ${videoId}`);

    const safeName = section.Title
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 80);

    // 2a. Télécharger le transcript VTT → markdown
    if (vttUrl) {
      const mdFile = path.join(OUTPUT_DIR, `${String(section.Order).padStart(2,'0')}_${safeName}.md`);
      if (!fs.existsSync(mdFile)) {
        console.log(`  Téléchargement VTT: ${vttUrl}`);
        try {
          const vttContent = await get(vttUrl);
          const md = vttToMarkdown(vttContent, section.Title);
          fs.writeFileSync(mdFile, md, 'utf8');
          console.log(`  ✓ Transcript: ${path.basename(mdFile)}`);
        } catch (e) {
          console.error(`  ✗ Erreur VTT: ${e}`);
        }
      } else {
        console.log(`  Déjà présent: ${path.basename(mdFile)}`);
      }
    } else {
      console.log('  — Pas de transcript VTT disponible');
    }

    // 2b. Télécharger le MP3
    const mp3File = path.join(OUTPUT_DIR, `${String(section.Order).padStart(2,'0')}_${safeName}.mp3`);
    if (!fs.existsSync(mp3File)) {
      console.log(`  Téléchargement MP3 (Dailymotion ${videoId})...`);
      const cmd = `yt-dlp "https://www.dailymotion.com/video/${videoId}" \
        --add-header "Referer:https://learning.cube.fr/" \
        --cookies "${COOKIES_FILE}" \
        -x --audio-format mp3 -o "${mp3File}" \
        --no-progress 2>&1`;
      try {
        execSync(cmd, { stdio: 'inherit', shell: '/bin/zsh' });
        console.log(`  ✓ MP3: ${path.basename(mp3File)}`);
      } catch (e) {
        console.error(`  ✗ Erreur MP3: ${e}`);
      }
    } else {
      console.log(`  Déjà présent: ${path.basename(mp3File)}`);
    }
  }

  console.log(`\nTerminé. Fichiers dans:\n  ${OUTPUT_DIR}`);
  console.log(fs.readdirSync(OUTPUT_DIR).join('\n  '));
}

main().catch(e => { console.error(e); process.exit(1); });

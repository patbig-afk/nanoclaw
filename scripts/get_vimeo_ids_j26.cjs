const { chromium } = require('playwright');

const EMAIL = 'patbig@gmail.com';
const PASSWORD = '!Internet1708';

const LESSONS = [
  { slug: 'structurer-un-projet',         url: 'https://learning.cube.fr/course/structurer-un-projet?course=1726239616737x133502646706004750' },
  { slug: 'organiser-visuellement',        url: 'https://learning.cube.fr/course/organiser-visuellement-une-page?course=1726239616737x133502646706004750' },
  { slug: 'saisir-une-donnee',             url: 'https://learning.cube.fr/course/saisir-une-donnee?course=1726239616737x133502646706004750' },
  { slug: 'afficher-les-images',           url: 'https://learning.cube.fr/course/afficher-les-images?course=1726239616737x133502646706004750' },
];

function getIds(page) {
  const ids = new Set();
  for (const frame of page.frames()) {
    const m = frame.url().match(/vimeo\.com\/video\/(\d+)/);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://learning.cube.fr/welcome', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  const inputs = await page.$$('input');
  await inputs[0].fill(EMAIL);
  await inputs[1].fill(PASSWORD);
  await inputs[1].press('Enter');
  await page.waitForTimeout(5000);

  const results = {};

  for (const lesson of LESSONS) {
    console.log(`\n--- ${lesson.slug} ---`);
    try {
      await page.goto(lesson.url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(6000);
      const ids = getIds(page);
      console.log(`IDs: ${ids.join(', ') || 'none'}`);
      results[lesson.slug] = ids;
    } catch(e) {
      console.log(`Error: ${e.message}`);
      results[lesson.slug] = [];
    }
  }

  await browser.close();
  console.log('\nRESULTS:', JSON.stringify(results, null, 2));
})();

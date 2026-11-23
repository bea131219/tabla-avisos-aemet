const { chromium } = require('playwright');
const fs = require('fs');

const AEMET_URL = 'https://www.aemet.es/es/eltiempo/prediccion/avisos?datos=img&f=AT&w=mna';

function tomorrowStampMadrid() {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

  const [y, m, d] = today.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  return `${tomorrow.getUTCFullYear()}${String(tomorrow.getUTCMonth() + 1).padStart(2, '0')}${String(tomorrow.getUTCDate()).padStart(2, '0')}`;
}

async function acceptCookies(page) {
  for (const selector of [
    'button:has-text("Aceptar cookies")',
    'a:has-text("Aceptar cookies")',
    'input[value*="Aceptar cookies"]',
    'text="Aceptar cookies"'
  ]) {
    try {
      await page.locator(selector).first().click({ timeout: 2500 });
      return;
    } catch {}
  }
}

async function getAvisosClip(page) {
  const headings = page.getByText('Avisos meteorológicos', { exact: true });
  const count = await headings.count();
  if (!count) throw new Error('No se encontro el encabezado Avisos meteorológicos.');

  // En AEMET hay un titulo general y otro asociado al bloque de la matriz.
  const heading = headings.nth(count - 1);
  await heading.waitFor({ state: 'visible', timeout: 30000 });
  await heading.scrollIntoViewIfNeeded();

  const detail = page.getByText('Detalle de avisos', { exact: true }).first();
  await detail.waitFor({ state: 'attached', timeout: 30000 });

  const headingBox = await heading.boundingBox();
  const detailBox = await detail.boundingBox();
  if (!headingBox || !detailBox) {
    throw new Error('No se pudieron obtener dimensiones del bloque Avisos meteorológicos.');
  }

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const left = 35;
  const top = Math.max(0, headingBox.y - 12);
  const right = Math.min(scrollWidth - 10, 1390);
  const bottom = detailBox.y - 10;

  if (bottom <= top || right <= left) {
    throw new Error(`Clip invalido: left=${left}, top=${top}, right=${right}, bottom=${bottom}`);
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

function detectAlertState(text) {
  const hasDetailHeaders =
    text.includes('Fenómenos previstos') &&
    text.includes('Nivel de aviso') &&
    text.includes('Zona de avisos');

  const hasAlertLevel = /Peligro\s+(bajo|importante|extraordinario)/i.test(text);
  const hasProbability = /\b\d{1,3}%\s*-\s*\d{1,3}%\b/.test(text);
  const hasKnownPhenomenon = /\b(Lluvias|Nevadas|Viento|Costeros|Tormentas|Temperaturas\s+(máximas|mínimas)|Aludes|Niebla|Deshielos)\b/i.test(text);

  return hasDetailHeaders && hasAlertLevel && (hasProbability || hasKnownPhenomenon)
    ? 'CON_AVISOS'
    : 'SIN_AVISOS';
}

(async () => {
  let browser;

  try {
    fs.mkdirSync('docs/archive', { recursive: true });

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1400, height: 1200 },
      deviceScaleFactor: 1
    });

    console.log(`Abriendo AEMET: ${AEMET_URL}`);
    await page.goto(AEMET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    });

    await acceptCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);

    // Esperar recursos graficos antes de capturar la matriz horaria.
    await page.evaluate(async () => {
      const images = Array.from(document.images);
      await Promise.all(images.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
      }));
    });

    const stamp = tomorrowStampMadrid();

    // 1) Captura de la tabla/matriz de Avisos meteorologicos.
    const clip = await getAvisosClip(page);
    const latestPng = 'docs/aemet-tabla-manana.png';
    const archivePng = `docs/archive/aemet-tabla-manana-${stamp}.png`;

    await page.screenshot({
      path: latestPng,
      type: 'png',
      clip
    });
    fs.copyFileSync(latestPng, archivePng);

    // 2) Estado de los avisos para Power Automate.
    const bodyText = await page.locator('body').innerText();
    const state = detectAlertState(bodyText);
    const latestTxt = 'docs/estado-avisos.txt';
    const archiveTxt = `docs/archive/estado-avisos-${stamp}.txt`;

    fs.writeFileSync(latestTxt, `${state}\n`, 'utf8');
    fs.writeFileSync(archiveTxt, `${state}\n`, 'utf8');

    console.log(`Captura actual: ${latestPng}`);
    console.log(`Captura historica: ${archivePng}`);
    console.log(`Estado AEMET ${stamp}: ${state}`);
    console.log(`Estado actual: ${latestTxt}`);
    console.log(`Estado historico: ${archiveTxt}`);
  } catch (error) {
    console.error('Error en capture-tabla.js:', error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();


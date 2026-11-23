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
  if (!count) throw new Error('No se encontro el encabezado Avisos meteorologicos.');

  // AEMET puede tener mas de un texto "Avisos meteorologicos".
  // Usamos el ultimo, que corresponde al bloque de la matriz horaria.
  const heading = headings.nth(count - 1);
  await heading.waitFor({ state: 'visible', timeout: 30000 });
  await heading.scrollIntoViewIfNeeded();

  // El detalle debe existir antes de calcular la captura completa.
  const detailHeading = page.getByText('Detalle de avisos', { exact: true }).first();
  await detailHeading.waitFor({ state: 'visible', timeout: 30000 });

  // Esperar a que se renderice la tabla de detalle. Los encabezados mostrados
  // por AEMET permiten localizarla sin depender de una clase CSS concreta.
  const detailHeader = page.getByText('Fenómenos previstos', { exact: true }).first();
  await detailHeader.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const headingBox = await heading.boundingBox();
  const detailHeadingBox = await detailHeading.boundingBox();

  if (!headingBox || !detailHeadingBox) {
    throw new Error('No se pudieron obtener las dimensiones de los bloques de avisos.');
  }

  // Localizar el contenedor visible que engloba el detalle, incluyendo filas.
  // Partimos del texto "Detalle de avisos" y buscamos, entre sus elementos
  // siguientes, el que llegue mas abajo y contenga los encabezados de la tabla.
  const detailBottom = await detailHeading.evaluate((el) => {
    const startY = el.getBoundingClientRect().top + window.scrollY;
    let bestBottom = el.getBoundingClientRect().bottom + window.scrollY;

    const candidates = Array.from(document.querySelectorAll('table, div'));
    for (const node of candidates) {
      const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text.includes('Fenómenos previstos') ||
          !text.includes('Nivel de aviso') ||
          !text.includes('Zona de avisos')) {
        continue;
      }

      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const top = rect.top + window.scrollY;
      const bottom = rect.bottom + window.scrollY;

      // Solo considerar la tabla situada debajo de "Detalle de avisos".
      if (bottom >= startY && top < startY + 500) {
        bestBottom = Math.max(bestBottom, bottom);
      }
    }

    return bestBottom;
  });

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);

  const left = 35;
  const top = Math.max(0, headingBox.y - 12);
  const right = Math.min(scrollWidth - 10, 1390);

  // CAMBIO PRINCIPAL: ya no terminamos antes de "Detalle de avisos".
  // La captura llega hasta el final de la tabla y deja un pequeno margen.
  const bottom = Math.min(scrollHeight - 5, Math.ceil(detailBottom + 15));

  if (bottom <= top || right <= left) {
    throw new Error(`Clip invalido: left=${left}, top=${top}, right=${right}, bottom=${bottom}`);
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
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

    // Esperar a que terminen de cargar imagenes e iconos antes de capturar.
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

    // 1) Captura conjunta:
    //    - Avisos meteorologicos (matriz horaria)
    //    - Detalle de avisos (tabla completa)
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


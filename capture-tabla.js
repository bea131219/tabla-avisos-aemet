const { chromium } = require('playwright');
const fs = require('fs');

function getTomorrowStampMadrid() {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  return `${tomorrow.getUTCFullYear()}${String(tomorrow.getUTCMonth() + 1).padStart(2, '0')}${String(tomorrow.getUTCDate()).padStart(2, '0')}`;
}

async function acceptCookies(page) {
  const selectors = [
    'button:has-text("Aceptar cookies")',
    'a:has-text("Aceptar cookies")',
    'input[value*="Aceptar cookies"]',
    'text="Aceptar cookies"'
  ];
  for (const selector of selectors) {
    try {
      await page.locator(selector).first().click({ timeout: 2500 });
      return;
    } catch {}
  }
}

async function getAvisosClip(page) {
  // Buscamos el segundo texto "Avisos meteorológicos", que corresponde
  // al encabezado de la matriz horaria, no el titulo general de la pagina.
  const titles = page.getByText('Avisos meteorológicos', { exact: true });
  const count = await titles.count();
  if (!count) throw new Error('No se encontro el encabezado Avisos meteorológicos.');

  let heading = titles.nth(count - 1);
  await heading.scrollIntoViewIfNeeded();
  await heading.waitFor({ state: 'visible', timeout: 30000 });

  // "Detalle de avisos" marca el limite inferior del bloque que queremos.
  const detail = page.getByText('Detalle de avisos', { exact: true }).first();
  await detail.waitFor({ state: 'attached', timeout: 30000 });

  const headingBox = await heading.boundingBox();
  const detailBox = await detail.boundingBox();
  if (!headingBox || !detailBox) {
    throw new Error('No se pudieron obtener las dimensiones del bloque de avisos.');
  }

  // Capturamos desde ligeramente encima del titulo hasta justo antes del detalle.
  // El ancho usa el area visible de contenido para incluir toda la escala 00-23.
  const left = 40;
  const top = Math.max(0, headingBox.y - 12);
  const right = Math.min(await page.evaluate(() => document.documentElement.scrollWidth), 1380);
  const bottom = detailBox.y - 10;

  if (bottom <= top) {
    throw new Error('La seccion Detalle de avisos aparece antes que la matriz horaria.');
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
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

    await page.goto(
      'https://www.aemet.es/es/eltiempo/prediccion/avisos?datos=img&f=AT&w=mna',
      { waitUntil: 'domcontentloaded', timeout: 90000 }
    );

    await acceptCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);

    // Esperar a las imagenes del documento, ya que la matriz utiliza recursos graficos.
    await page.evaluate(async () => {
      const images = Array.from(document.images);
      await Promise.all(images.map(img => img.complete ? Promise.resolve() : new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      })));
    });

    const clip = await getAvisosClip(page);
    const latestFile = 'docs/aemet-tabla-manana.png';
    const archiveFile = `docs/archive/aemet-tabla-manana-${getTomorrowStampMadrid()}.png`;

    await page.screenshot({ path: latestFile, type: 'png', clip });
    fs.copyFileSync(latestFile, archiveFile);

    console.log(`Captura creada: ${latestFile}`);
    console.log(`Historico creado: ${archiveFile}`);
  } catch (error) {
    console.error('Error durante la captura:', error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();

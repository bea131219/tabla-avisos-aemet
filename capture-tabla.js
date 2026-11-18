const { chromium } = require('playwright');
const fs = require('fs');

// Devuelve la fecha de manana en Madrid con formato YYYYMMDD.
function getTomorrowStampMadrid() {
  const madridToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

  const [year, month, day] = madridToday.split('-').map(Number);
  const tomorrowUtc = new Date(Date.UTC(year, month - 1, day + 1));

  return [
    tomorrowUtc.getUTCFullYear(),
    String(tomorrowUtc.getUTCMonth() + 1).padStart(2, '0'),
    String(tomorrowUtc.getUTCDate()).padStart(2, '0')
  ].join('');
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
      await page.locator(selector).first().click({ timeout: 3000 });
      console.log('Aviso de cookies cerrado.');
      return;
    } catch {
      // Probar el siguiente selector.
    }
  }

  console.log('No se encontro el aviso de cookies o ya estaba aceptado.');
}

async function findWarningsTable(page) {
  // La tabla deseada contiene las 24 horas y comunidades autonomas.
  // Priorizamos una tabla cercana al texto "Avisos meteorologicos".
  const heading = page.getByText('Avisos meteorológicos', { exact: true }).last();

  if (await heading.count()) {
    const nearHeading = heading.locator('xpath=following::table[1]');
    if (await nearHeading.count()) {
      return nearHeading.first();
    }
  }

  // Respaldo por contenido caracteristico de la tabla.
  const candidates = page.locator('table');
  for (let i = 0; i < await candidates.count(); i++) {
    const table = candidates.nth(i);
    const text = (await table.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (
      text.includes('Andalucía') &&
      text.includes('Cantabria') &&
      text.includes('00') &&
      text.includes('23')
    ) {
      return table;
    }
  }

  throw new Error('No se pudo localizar la tabla de Avisos meteorológicos.');
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

    console.log('Abriendo los avisos meteorologicos de manana...');

    await page.goto(
      'https://www.aemet.es/es/eltiempo/prediccion/avisos?datos=img&f=AT&w=mna',
      {
        waitUntil: 'domcontentloaded',
        timeout: 90000
      }
    );

    await acceptCookies(page);

    // Esperar las peticiones y el renderizado dinamico de AEMET.
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const table = await findWarningsTable(page);
    await table.waitFor({ state: 'visible', timeout: 60000 });
    await table.scrollIntoViewIfNeeded();

    // Esperar a que las imagenes/iconos internos terminen de cargar.
    await table.evaluate(async (element) => {
      const images = Array.from(element.querySelectorAll('img'));
      await Promise.all(
        images.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          });
        })
      );
    });

    await page.waitForTimeout(1000);

    const tomorrowStamp = getTomorrowStampMadrid();
    const latestFile = 'docs/aemet-tabla-manana.png';
    const archiveFile = `docs/archive/aemet-tabla-manana-${tomorrowStamp}.png`;

    // Capturar exclusivamente la tabla de avisos horarios.
    await table.screenshot({
      path: latestFile,
      type: 'png'
    });

    fs.copyFileSync(latestFile, archiveFile);

    console.log(`Tabla actualizada: ${latestFile}`);
    console.log(`Tabla archivada: ${archiveFile}`);
  } catch (error) {
    console.error('Error durante la captura de la tabla:', error);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
})();

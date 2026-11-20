const { chromium } = require('playwright');
const fs = require('fs');

function tomorrowStampMadrid() {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth()+1).padStart(2,'0')}${String(t.getUTCDate()).padStart(2,'0')}`;
}

async function acceptCookies(page) {
  for (const s of ['button:has-text("Aceptar cookies")','a:has-text("Aceptar cookies")','text="Aceptar cookies"']) {
    try { await page.locator(s).first().click({timeout:2000}); return; } catch {}
  }
}

(async () => {
  let browser;
  try {
    fs.mkdirSync('docs/archive', { recursive: true });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });

    await page.goto('https://www.aemet.es/es/eltiempo/prediccion/avisos?datos=img&f=AT&w=mna', {
      waitUntil: 'domcontentloaded', timeout: 90000
    });
    await acceptCookies(page);
    await page.waitForLoadState('networkidle', {timeout:30000}).catch(()=>{});
    await page.waitForTimeout(3000);

    // AEMET incluye una seccion "Detalle de avisos". Si existen avisos,
    // aparecen filas/datos de fenomenos previstos. Evitamos decidir por colores del PNG.
    const detailHeading = page.getByText('Detalle de avisos', { exact: true }).first();
    await detailHeading.waitFor({ state: 'attached', timeout: 30000 });

    const detailText = await page.locator('body').innerText();
    const hasDetailHeaders =
      detailText.includes('Fenómenos previstos') &&
      detailText.includes('Nivel de aviso') &&
      detailText.includes('Zona de avisos');

    // Indicadores de una fila real de aviso. Se combinan varios para reducir falsos positivos.
    const hasAlertLevel = /Peligro\s+(bajo|importante|extraordinario)/i.test(detailText);
    const hasProbability = /\b\d{1,3}%\s*-\s*\d{1,3}%\b/.test(detailText);
    const hasKnownPhenomenon = /\b(Lluvias|Nevadas|Viento|Costeros|Tormentas|Temperaturas\s+(máximas|mínimas)|Aludes|Niebla|Deshielos)\b/i.test(detailText);

    const state = hasDetailHeaders && hasAlertLevel && (hasProbability || hasKnownPhenomenon)
      ? 'CON_AVISOS'
      : 'SIN_AVISOS';

    const stamp = tomorrowStampMadrid();
    const latest = 'docs/estado-avisos.txt';
    const archive = `docs/archive/estado-avisos-${stamp}.txt`;

    fs.writeFileSync(latest, state + '\n', 'utf8');
    fs.writeFileSync(archive, state + '\n', 'utf8');

    console.log(`Estado AEMET para ${stamp}: ${state}`);
    console.log(`Generado: ${latest}`);
    console.log(`Generado: ${archive}`);
  } catch (e) {
    console.error('No se pudo determinar el estado de avisos:', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();

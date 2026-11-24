const { chromium } = require('playwright');
const fs = require('fs');

const URL = 'https://www.aemet.es/es/eltiempo/prediccion/avisos?datos=img&f=AT&w=mna';

function fechaManana() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
}

async function aceptarCookies(page) {
  for (const s of ['button:has-text("Aceptar cookies")','a:has-text("Aceptar cookies")','text="Aceptar cookies"']) {
    try { await page.locator(s).first().click({ timeout: 2000 }); return; } catch {}
  }
}

function estadoAvisos(texto) {
  const cabeceras = texto.includes('Fenómenos previstos') &&
    texto.includes('Nivel de aviso') && texto.includes('Zona de avisos');
  const nivel = /Peligro\s+(bajo|importante|extraordinario)/i.test(texto);
  return cabeceras && nivel ? 'CON_AVISOS' : 'SIN_AVISOS';
}

(async () => {
  let browser;
  try {
    fs.mkdirSync('docs/archive', { recursive: true });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 1
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await aceptarCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    const tituloAvisos = page.getByText('Avisos meteorológicos', { exact: true }).last();
    const tituloDetalle = page.getByText('Detalle de avisos', { exact: true }).last();
    await tituloAvisos.waitFor({ state: 'visible', timeout: 30000 });
    await tituloDetalle.waitFor({ state: 'visible', timeout: 30000 });
    await tituloDetalle.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);

    const tabla = page.locator('table').filter({
      hasText: 'Fenómenos previstos'
    }).filter({
      hasText: 'Nivel de aviso'
    }).filter({
      hasText: 'Comentario'
    }).last();

    await tabla.waitFor({ state: 'visible', timeout: 30000 });

    // Forzar la carga de toda la tabla desplazandonos hasta su ultima fila.
    const filas = tabla.locator('tr');
    const numeroFilas = await filas.count();
    if (numeroFilas > 0) {
      await filas.nth(numeroFilas - 1).scrollIntoViewIfNeeded();
      await page.waitForTimeout(2000);
    }

    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).map(img =>
        img.complete ? Promise.resolve() : new Promise(resolve => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        })
      ));
    });

    // Capturamos el bloque completo: Avisos meteorologicos + Detalle de avisos completo.
    // No se incluye el bloque superior de Avisos meteorologicos.
    const limites = await page.evaluate(() => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const todos = Array.from(document.querySelectorAll('body *'));
      const tituloAvisosDOM = todos.find(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && norm(el.textContent) === 'Avisos meteorológicos';
      });
      const titulo = todos.find(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && norm(el.textContent) === 'Detalle de avisos';
      });
      if (!tituloAvisosDOM || !titulo) throw new Error('No se encontraron los bloques Avisos meteorológicos / Detalle de avisos');

      const yInicio = tituloAvisosDOM.getBoundingClientRect().top + window.scrollY;
      const yTitulo = titulo.getBoundingClientRect().top + window.scrollY;
      const tablas = Array.from(document.querySelectorAll('table')).filter(t => {
        const txt = norm(t.innerText);
        const r = t.getBoundingClientRect();
        return r.width > 0 && r.height > 0 &&
          r.top + window.scrollY >= yTitulo - 20 &&
          txt.includes('Fenómenos previstos') &&
          txt.includes('Nivel de aviso') &&
          txt.includes('Zona de avisos') &&
          txt.includes('Comentario');
      });
      if (!tablas.length) throw new Error('No se encontro la tabla Detalle de avisos');

      const t = tablas.sort((a,b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
      const rt = t.getBoundingClientRect();
      const rr = Array.from(t.querySelectorAll('tr')).map(tr => tr.getBoundingClientRect());
      const bottom = Math.max(rt.bottom + window.scrollY, ...rr.map(r => r.bottom + window.scrollY));
      const left = Math.min(tituloAvisosDOM.getBoundingClientRect().left, titulo.getBoundingClientRect().left, rt.left) + window.scrollX;
      const right = Math.max(tituloAvisosDOM.getBoundingClientRect().right, titulo.getBoundingClientRect().right, rt.right) + window.scrollX;

      return {
        x: Math.max(0, Math.floor(left - 8)),
        y: Math.max(0, Math.floor(yInicio - 8)),
        right: Math.ceil(right + 8),
        bottom: Math.ceil(bottom + 15),
        filas: rr.length,
        docW: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
        docH: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
      };
    });

    const clip = {
      x: limites.x,
      y: limites.y,
      width: Math.min(limites.right, limites.docW) - limites.x,
      height: Math.min(limites.bottom, limites.docH) - limites.y
    };
    if (clip.width <= 0 || clip.height <= 0) throw new Error(`Clip invalido: ${JSON.stringify(clip)}`);

    console.log(`Filas detectadas en Detalle de avisos: ${limites.filas}`);
    console.log('Clip Avisos meteorologicos + Detalle completo:', clip);

    const fecha = fechaManana();
    const png = 'docs/aemet-tabla-manana.png';
    await page.screenshot({ path: png, type: 'png', clip, animations: 'disabled' });
    fs.copyFileSync(png, `docs/archive/aemet-tabla-manana-${fecha}.png`);

    const estado = estadoAvisos(await page.locator('body').innerText());
    fs.writeFileSync('docs/estado-avisos.txt', `${estado}\n`, 'utf8');
    fs.writeFileSync(`docs/archive/estado-avisos-${fecha}.txt`, `${estado}\n`, 'utf8');

    console.log(`Captura generada: ${png}`);
    console.log(`Estado: ${estado}`);
  } catch (e) {
    console.error('Error en capture-tabla.js:', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();

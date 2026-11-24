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
  const cabeceras = texto.includes('Fenómenos previstos') && texto.includes('Nivel de aviso') && texto.includes('Zona de avisos');
  const nivel = /Peligro\s+(bajo|importante|extraordinario)/i.test(texto);
  return cabeceras && nivel ? 'CON_AVISOS' : 'SIN_AVISOS';
}

(async () => {
  let browser;
  try {
    fs.mkdirSync('docs/archive', { recursive: true });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await aceptarCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    const tituloResumen = page.getByText('Avisos meteorológicos', { exact: true }).last();
    const tituloDetalle = page.getByText('Detalle de avisos', { exact: true }).last();
    await tituloResumen.waitFor({ state: 'visible', timeout: 30000 });
    await tituloDetalle.waitFor({ state: 'visible', timeout: 30000 });

    // La tabla resumen NO se localiza por el texto 00/23 ni por el nombre del dia.
    // En AEMET esos textos pueden no estar disponibles como innerText en Chromium.
    // En su lugar, buscamos la primera tabla visible situada entre los titulos
    // "Avisos meteorológicos" y "Detalle de avisos".
    const tablaResumen = page.locator('table').filter({
      has: page.locator('tr')
    }).filter({
      hasNotText: 'Fenómenos previstos'
    }).filter({
      hasNotText: 'Nivel de aviso'
    });

    const tablaDetalle = page.locator('table').filter({ hasText: 'Fenómenos previstos' }).filter({ hasText: 'Nivel de aviso' }).filter({ hasText: 'Zona de avisos' }).filter({ hasText: 'Comentario' }).last();

    await tablaDetalle.waitFor({ state: 'visible', timeout: 30000 });

    // Forzar renderizado completo de la tabla de detalle y esperar estabilidad.
    let f0 = -1, h0 = -1, estable = 0;
    for (let i = 0; i < 15 && estable < 3; i++) {
      const filas = tablaDetalle.locator('tr');
      const n = await filas.count();
      if (n) await filas.nth(n - 1).scrollIntoViewIfNeeded();
      await page.waitForTimeout(700);
      const b = await tablaDetalle.boundingBox();
      const h = b ? Math.round(b.height) : -1;
      if (n === f0 && h === h0) estable++; else estable = 0;
      f0 = n; h0 = h;
    }

    // Esperar iconos de ambos bloques.
    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).map(img => img.complete ? Promise.resolve() : new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      })));
    });

    // Captura 1: resumen "Avisos meteorológicos", incluido su titulo.
    // Determinamos el bloque por POSICION en la pagina, no por los textos horarios.
    const resumenClip = await page.evaluate(() => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const visibles = Array.from(document.querySelectorAll('body *')).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      const tituloResumen = visibles.find(el => norm(el.textContent) === 'Avisos meteorológicos');
      const tituloDetalle = visibles.find(el => norm(el.textContent) === 'Detalle de avisos');
      if (!tituloResumen || !tituloDetalle) {
        throw new Error('No se localizaron los titulos Avisos meteorológicos / Detalle de avisos.');
      }

      const rInicio = tituloResumen.getBoundingClientRect();
      const rDetalle = tituloDetalle.getBoundingClientRect();
      const yInicio = rInicio.top + window.scrollY;
      const yDetalle = rDetalle.top + window.scrollY;

      const tablas = Array.from(document.querySelectorAll('table')).filter(t => {
        const r = t.getBoundingClientRect();
        const top = r.top + window.scrollY;
        const bottom = r.bottom + window.scrollY;
        return r.width > 300 && r.height > 40 && top >= yInicio - 20 && bottom < yDetalle;
      });

      if (!tablas.length) {
        throw new Error('No se encontro la tabla situada bajo Avisos meteorológicos.');
      }

      // Si hubiera tablas anidadas, elegimos el contenedor de mayor superficie.
      const tabla = tablas.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return (rb.width * rb.height) - (ra.width * ra.height);
      })[0];

      const rTabla = tabla.getBoundingClientRect();
      const x = Math.max(0, Math.floor(Math.min(rInicio.left, rTabla.left) + window.scrollX - 8));
      const y = Math.max(0, Math.floor(yInicio - 8));
      const right = Math.ceil(Math.max(rInicio.right, rTabla.right) + window.scrollX + 8);
      const bottom = Math.ceil(rTabla.bottom + window.scrollY + 8);
      return { x, y, width: right - x, height: bottom - y };
    });

    const fecha = fechaManana();
    const resumen = 'docs/aemet-avisos-resumen-manana.png';
    const detalle = 'docs/aemet-tabla-manana.png';

    await page.screenshot({ path: resumen, type: 'png', clip: resumenClip, animations: 'disabled' });

    // Captura 2: tabla de detalle COMPLETA. Screenshot directo del elemento evita cortes por altura.
    const filasFinales = await tablaDetalle.locator('tr').count();
    const boxDetalle = await tablaDetalle.boundingBox();
    if (!boxDetalle) throw new Error('No se obtuvieron dimensiones de Detalle de avisos.');
    await tablaDetalle.screenshot({ path: detalle, type: 'png', animations: 'disabled' });

    fs.copyFileSync(resumen, `docs/archive/aemet-avisos-resumen-manana-${fecha}.png`);
    fs.copyFileSync(detalle, `docs/archive/aemet-tabla-manana-${fecha}.png`);

    const estado = estadoAvisos(await page.locator('body').innerText());
    fs.writeFileSync('docs/estado-avisos.txt', `${estado}\n`, 'utf8');
    fs.writeFileSync(`docs/archive/estado-avisos-${fecha}.txt`, `${estado}\n`, 'utf8');

    console.log(`Resumen generado: ${resumen}`);
    console.log(`Detalle generado: ${detalle}`);
    console.log(`Filas detalle detectadas: ${filasFinales}`);
    console.log(`Altura detalle: ${Math.round(boxDetalle.height)} px`);
    console.log(`Estado: ${estado}`);
  } catch (e) {
    console.error('Error en capture-tabla.js:', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();


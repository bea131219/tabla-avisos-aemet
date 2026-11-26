const { chromium } = require('playwright');
const fs = require('fs');

const URL = 'https://www.aemet.es/es/eltiempo/prediccion/avisos?datos=img&f=AT&w=mna';

function fechaManana() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function aceptarCookies(page) {
  for (const s of ['button:has-text("Aceptar cookies")', 'a:has-text("Aceptar cookies")', 'text="Aceptar cookies"']) {
    try { await page.locator(s).first().click({ timeout: 2000 }); return; } catch {}
  }
}

function estadoAvisos(texto) {
  const cab = texto.includes('Fenómenos previstos') && texto.includes('Nivel de aviso') && texto.includes('Zona de avisos');
  const nivel = /Peligro\s+(bajo|importante|extraordinario)/i.test(texto);
  return cab && nivel ? 'CON_AVISOS' : 'SIN_AVISOS';
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

    const tablaDetalle = page.locator('table')
      .filter({ hasText: 'Fenómenos previstos' })
      .filter({ hasText: 'Nivel de aviso' })
      .filter({ hasText: 'Zona de avisos' })
      .filter({ hasText: 'Comentario' })
      .last();
    await tablaDetalle.waitFor({ state: 'visible', timeout: 30000 });

    // Esperar a que la tabla de detalle se estabilice y cargue todas sus filas.
    let f0 = -1, h0 = -1, estable = 0;
    for (let i = 0; i < 15 && estable < 3; i++) {
      const filas = tablaDetalle.locator('tr');
      const n = await filas.count();
      if (n) await filas.nth(n - 1).scrollIntoViewIfNeeded();
      await page.waitForTimeout(700);
      const b = await tablaDetalle.boundingBox();
      const h = b ? Math.round(b.height) : -1;
      if (n === f0 && h === h0) estable++; else estable = 0;
      f0 = n;
      h0 = h;
    }

    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).map(img => img.complete ? Promise.resolve() : new Promise(r => {
        img.addEventListener('load', r, { once: true });
        img.addEventListener('error', r, { once: true });
      })));
    });

    const fecha = fechaManana();
    const pngResumen = 'docs/aemet-avisos-resumen-manana.png';
    const pngDetalle = 'docs/aemet-tabla-manana.png';

    // RESUMEN ROBUSTO: crear una copia aislada de todo el contenido comprendido
    // entre el titulo "Avisos meteorológicos" y el titulo "Detalle de avisos".
    // Al usar un Range del DOM, nunca se incluye el mapa superior ni el detalle inferior.
    await tituloResumen.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    const resumenAislado = await page.evaluate(() => {
      const norm = v => (v || '').replace(/\s+/g, ' ').trim();
      const visibles = Array.from(document.querySelectorAll('body *')).filter(el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      });

      const resumenes = visibles.filter(el => norm(el.textContent) === 'Avisos meteorológicos');
      const detalles = visibles.filter(el => norm(el.textContent) === 'Detalle de avisos');
      if (!resumenes.length || !detalles.length) {
        throw new Error('No se encontraron los titulos Avisos meteorológicos / Detalle de avisos.');
      }

      let resumen = null;
      let detalle = null;
      for (let i = resumenes.length - 1; i >= 0; i--) {
        const yResumen = resumenes[i].getBoundingClientRect().top + window.scrollY;
        const siguientes = detalles
          .map(el => ({ el, y: el.getBoundingClientRect().top + window.scrollY }))
          .filter(x => x.y > yResumen)
          .sort((a, b) => a.y - b.y);
        if (siguientes.length) {
          resumen = resumenes[i];
          detalle = siguientes[0].el;
          break;
        }
      }
      if (!resumen || !detalle) throw new Error('No se pudo delimitar el bloque Avisos meteorológicos.');

      // Copiar exactamente el fragmento comprendido entre ambos titulos.
      const range = document.createRange();
      range.setStartBefore(resumen);
      range.setEndBefore(detalle);
      const fragmento = range.cloneContents();

      const anterior = document.getElementById('captura-avisos-aislada');
      if (anterior) anterior.remove();

      const contenedor = document.createElement('div');
      contenedor.id = 'captura-avisos-aislada';
      contenedor.style.position = 'absolute';
      contenedor.style.left = '0';
      contenedor.style.top = '0';
      contenedor.style.zIndex = '2147483647';
      contenedor.style.background = '#ffffff';
      contenedor.style.padding = '8px';
      contenedor.style.boxSizing = 'border-box';

      // Mantener el ancho real del contenido de AEMET sin incluir fondos laterales.
      const anchoReferencia = Math.max(
        resumen.getBoundingClientRect().width,
        Math.min(1400, detalle.getBoundingClientRect().width)
      );
      contenedor.style.width = `${Math.ceil(anchoReferencia + 16)}px`;
      contenedor.appendChild(fragmento);
      document.body.appendChild(contenedor);

      // Eliminar del clon elementos vacios o flotantes ajenos a la matriz.
      contenedor.querySelectorAll('script, noscript').forEach(el => el.remove());
      return true;
    });

    if (!resumenAislado) throw new Error('No se pudo crear la captura aislada de Avisos meteorológicos.');

    const bloqueResumen = page.locator('#captura-avisos-aislada');
    await bloqueResumen.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(500);
    const boxResumen = await bloqueResumen.boundingBox();
    if (!boxResumen || boxResumen.width <= 0 || boxResumen.height <= 0) {
      throw new Error('El bloque aislado de Avisos meteorológicos no tiene dimensiones validas.');
    }

    console.log(`Resumen aislado: ${Math.round(boxResumen.width)} x ${Math.round(boxResumen.height)} px`);
    await bloqueResumen.screenshot({
      path: pngResumen,
      type: 'png',
      animations: 'disabled'
    });

    // DETALLE COMPLETO: mantener screenshot directo del elemento TABLE.
    await tablaDetalle.screenshot({ path: pngDetalle, type: 'png', animations: 'disabled' });

    fs.copyFileSync(pngResumen, `docs/archive/aemet-avisos-resumen-manana-${fecha}.png`);
    fs.copyFileSync(pngDetalle, `docs/archive/aemet-tabla-manana-${fecha}.png`);

    const estado = estadoAvisos(await page.locator('body').innerText());
    fs.writeFileSync('docs/estado-avisos.txt', `${estado}\n`, 'utf8');
    fs.writeFileSync(`docs/archive/estado-avisos-${fecha}.txt`, `${estado}\n`, 'utf8');

    console.log(`Resumen generado: ${pngResumen}`);
    console.log(`Detalle completo generado: ${pngDetalle}`);
    console.log(`Estado: ${estado}`);
  } catch (e) {
    console.error('Error en capture-tabla.js:', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();


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
  for (const selector of [
    'button:has-text("Aceptar cookies")',
    'a:has-text("Aceptar cookies")',
    'text="Aceptar cookies"'
  ]) {
    try {
      await page.locator(selector).first().click({ timeout: 2000 });
      return;
    } catch {}
  }
}

function estadoAvisos(texto) {
  const cabeceras = texto.includes('Fenómenos previstos') &&
    texto.includes('Nivel de aviso') &&
    texto.includes('Zona de avisos');
  const nivel = /Peligro\s+(bajo|importante|extraordinario)/i.test(texto);
  return cabeceras && nivel ? 'CON_AVISOS' : 'SIN_AVISOS';
}

(async () => {
  let browser;

  try {
    fs.mkdirSync('docs/archive', { recursive: true });

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1200 },
      deviceScaleFactor: 1
    });

    await page.goto(URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    });

    await aceptarCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    const tituloResumen = page.getByText('Avisos meteorológicos', { exact: true }).last();
    const tituloDetalle = page.getByText('Detalle de avisos', { exact: true }).last();
    await tituloResumen.waitFor({ state: 'visible', timeout: 30000 });
    await tituloDetalle.waitFor({ state: 'visible', timeout: 30000 });
    await tituloDetalle.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);

    // Localizar SOLO la tabla real de Detalle de avisos.
    const tablaDetalle = page.locator('table').filter({
      hasText: 'Fenómenos previstos'
    }).filter({
      hasText: 'Nivel de aviso'
    }).filter({
      hasText: 'Zona de avisos'
    }).filter({
      hasText: 'Comentario'
    }).last();

    await tablaDetalle.waitFor({ state: 'visible', timeout: 30000 });

    // Esperar a que AEMET haya incorporado todas las filas. Se considera estable
    // cuando el numero de filas y la altura dejan de cambiar en varias comprobaciones.
    let anteriorFilas = -1;
    let anteriorAlto = -1;
    let estable = 0;

    for (let intento = 0; intento < 15 && estable < 3; intento++) {
      const filas = tablaDetalle.locator('tr');
      const total = await filas.count();

      if (total > 0) {
        await filas.nth(total - 1).scrollIntoViewIfNeeded();
      }

      await page.waitForTimeout(700);

      const box = await tablaDetalle.boundingBox();
      const alto = box ? Math.round(box.height) : -1;

      if (total === anteriorFilas && alto === anteriorAlto) {
        estable++;
      } else {
        estable = 0;
      }

      anteriorFilas = total;
      anteriorAlto = alto;
    }

    // Esperar los iconos de fenomenos contenidos en la tabla.
    await tablaDetalle.evaluate(async (tabla) => {
      const imagenes = Array.from(tabla.querySelectorAll('img'));
      await Promise.all(imagenes.map(img => img.complete ? Promise.resolve() : new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      })));
    });

    const filasFinales = await tablaDetalle.locator('tr').count();
    const boxFinal = await tablaDetalle.boundingBox();

    if (!boxFinal || boxFinal.width <= 0 || boxFinal.height <= 0) {
      throw new Error('No se pudieron obtener las dimensiones finales de la tabla Detalle de avisos.');
    }

    console.log(`Filas finales detectadas: ${filasFinales}`);
    console.log(`Tamano final tabla: ${Math.round(boxFinal.width)} x ${Math.round(boxFinal.height)} px`);

    const fecha = fechaManana();
    const pngResumen = 'docs/aemet-avisos-resumen-manana.png';
    const png = 'docs/aemet-tabla-manana.png';
    const historicoResumen = `docs/archive/aemet-avisos-resumen-manana-${fecha}.png`;
    const historicoPng = `docs/archive/aemet-tabla-manana-${fecha}.png`;

    // RESUMEN: capturar exactamente el bloque visible de "Avisos meteorológicos".
    // El limite inferior es el comienzo de "Detalle de avisos" y el limite horizontal
    // se calcula con los elementos visibles que hay dentro de esa franja.
    const resumenClip = await page.evaluate(() => {
      const norm = v => (v || '').replace(/\s+/g, ' ').trim();
      const elementos = Array.from(document.querySelectorAll('body *')).filter(el => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      });

      const titulosResumen = elementos.filter(el => norm(el.textContent) === 'Avisos meteorológicos');
      const titulosDetalle = elementos.filter(el => norm(el.textContent) === 'Detalle de avisos');
      if (!titulosResumen.length || !titulosDetalle.length) {
        throw new Error('No se encontraron los titulos Avisos meteorológicos / Detalle de avisos.');
      }

      // Elegimos la pareja en orden vertical: el Detalle debe estar debajo del Resumen.
      let a = null, d = null;
      for (const candidatoA of titulosResumen) {
        const ra = candidatoA.getBoundingClientRect();
        const ya = ra.top + window.scrollY;
        const candidatosD = titulosDetalle
          .map(el => ({ el, y: el.getBoundingClientRect().top + window.scrollY }))
          .filter(x => x.y > ya)
          .sort((x, y) => x.y - y.y);
        if (candidatosD.length) {
          a = candidatoA;
          d = candidatosD[0].el;
          break;
        }
      }
      if (!a || !d) throw new Error('No se pudo delimitar el bloque Avisos meteorológicos.');

      const ra = a.getBoundingClientRect();
      const rd = d.getBoundingClientRect();
      const top = ra.top + window.scrollY;
      const bottom = rd.top + window.scrollY - 12;

      // Considerar solamente elementos contenidos en la franja del resumen.
      const dentro = elementos.filter(el => {
        const r = el.getBoundingClientRect();
        const t = r.top + window.scrollY;
        const b = r.bottom + window.scrollY;
        return b >= top && t < bottom;
      });

      const left = Math.min(...dentro.map(el => el.getBoundingClientRect().left + window.scrollX));
      const right = Math.max(...dentro.map(el => el.getBoundingClientRect().right + window.scrollX));

      // Evitar que elementos globales (body/main) ensanchen el recorte: usamos como
      // referencia el contenido del titulo y limitamos a un ancho maximo razonable.
      const x = Math.max(0, Math.floor(Math.min(ra.left + window.scrollX, left) - 8));
      const docW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
      const maxRight = Math.min(docW - 5, x + 1500);
      const rFinal = Math.min(Math.ceil(right + 8), maxRight);
      const y = Math.max(0, Math.floor(top - 8));
      const bFinal = Math.ceil(bottom);

      return { x, y, width: rFinal - x, height: bFinal - y };
    });

    if (resumenClip.width <= 0 || resumenClip.height <= 0) {
      throw new Error(`Recorte del resumen invalido: ${JSON.stringify(resumenClip)}`);
    }

    // Muy importante: volver al inicio del resumen antes de capturar. Sin esto,
    // Playwright puede conservar el scroll usado para llegar a la ultima fila del detalle.
    await tituloResumen.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: pngResumen, type: 'png', clip: resumenClip, animations: 'disabled' });

    // DETALLE: mantenemos exactamente el metodo que ya funciona: captura del elemento TABLE completo.
    await tablaDetalle.screenshot({ path: png, type: 'png', animations: 'disabled' });

    fs.copyFileSync(pngResumen, historicoResumen);
    fs.copyFileSync(png, historicoPng);

    const textoPagina = await page.locator('body').innerText();
    const estado = estadoAvisos(textoPagina);
    fs.writeFileSync('docs/estado-avisos.txt', `${estado}\n`, 'utf8');
    fs.writeFileSync(`docs/archive/estado-avisos-${fecha}.txt`, `${estado}\n`, 'utf8');

    console.log(`Resumen generado: ${pngResumen}`);
    console.log(`Captura completa generada: ${png}`);
    console.log(`Historico: ${historicoPng}`);
    console.log(`Estado: ${estado}`);

  } catch (error) {
    console.error('Error en capture-tabla.js:', error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();

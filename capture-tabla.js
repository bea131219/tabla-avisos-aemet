const { chromium } = require('playwright');
const fs = require('fs');

const URL = 'https://www.aemet.es/es/eltiempo/prediccion/avisos?datos=img&f=AT&w=mna';

function fechaManana() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Madrid', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date()).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1]-1, p[2]+1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
}
async function aceptarCookies(page) {
  for (const s of ['button:has-text("Aceptar cookies")','a:has-text("Aceptar cookies")','text="Aceptar cookies"']) {
    try { await page.locator(s).first().click({timeout:2000}); return; } catch {}
  }
}
function estadoAvisos(t) {
  return t.includes('Fenómenos previstos') && /Peligro\s+(bajo|importante|extraordinario)/i.test(t) ? 'CON_AVISOS' : 'SIN_AVISOS';
}

(async()=>{
  let browser;
  try {
    fs.mkdirSync('docs/archive',{recursive:true});
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:1600,height:1200},deviceScaleFactor:1});
    await page.goto(URL,{waitUntil:'domcontentloaded',timeout:90000});
    await aceptarCookies(page);
    await page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{});

    const tituloResumen=page.getByText('Avisos meteorológicos',{exact:true}).last();
    const tituloDetalle=page.getByText('Detalle de avisos',{exact:true}).last();
    await tituloResumen.waitFor({state:'visible',timeout:30000});
    await tituloDetalle.waitFor({state:'visible',timeout:30000});

    const tablaDetalle=page.locator('table').filter({hasText:'Fenómenos previstos'}).filter({hasText:'Nivel de aviso'}).filter({hasText:'Zona de avisos'}).filter({hasText:'Comentario'}).last();
    await tablaDetalle.waitFor({state:'visible',timeout:30000});

    let f0=-1,h0=-1,estable=0;
    for(let i=0;i<15 && estable<3;i++){
      const filas=tablaDetalle.locator('tr'); const n=await filas.count();
      if(n) await filas.nth(n-1).scrollIntoViewIfNeeded();
      await page.waitForTimeout(700);
      const b=await tablaDetalle.boundingBox(); const h=b?Math.round(b.height):-1;
      if(n===f0 && h===h0) estable++; else estable=0;
      f0=n; h0=h;
    }
    await page.evaluate(async()=>Promise.all(Array.from(document.images).map(img=>img.complete?Promise.resolve():new Promise(r=>{img.onload=r;img.onerror=r;}))));

    const fecha=fechaManana();
    const pngResumen='docs/aemet-avisos-resumen-manana.png';
    const pngDetalle='docs/aemet-tabla-manana.png';

    // Seleccionar directamente los dos títulos de Playwright y obtener sus coordenadas
    // absolutas. Así no se confunden con copias ocultas, cabeceras o el pie de la página.
    await tituloResumen.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    const boxResumen=await tituloResumen.boundingBox();
    const boxDetalleTitulo=await tituloDetalle.boundingBox();
    if(!boxResumen || !boxDetalleTitulo) throw new Error('No se pudieron medir los dos títulos.');
    if(boxDetalleTitulo.y<=boxResumen.y) throw new Error('Detalle de avisos no está debajo de Avisos meteorológicos.');

    // Tomar el ancho del área principal de AEMET a partir de la tabla de detalle.
    const boxTabla=await tablaDetalle.boundingBox();
    if(!boxTabla) throw new Error('No se pudo medir la tabla de detalle.');

    const x=Math.max(0,Math.floor(Math.min(boxResumen.x,boxTabla.x)-8));
    const y=Math.max(0,Math.floor(boxResumen.y-8));
    const right=Math.ceil(Math.max(boxResumen.x+boxResumen.width,boxTabla.x+boxTabla.width)+8);
    const bottom=Math.floor(boxDetalleTitulo.y-10);
    const clip={x,y,width:right-x,height:bottom-y};
    if(clip.width<=0 || clip.height<=0) throw new Error(`Clip inválido: ${JSON.stringify(clip)}`);

    console.log('Título Avisos:',boxResumen);
    console.log('Título Detalle:',boxDetalleTitulo);
    console.log('Recorte exacto entre títulos:',clip);
    await page.screenshot({path:pngResumen,type:'png',clip,animations:'disabled'});

    await tablaDetalle.screenshot({path:pngDetalle,type:'png',animations:'disabled'});
    fs.copyFileSync(pngResumen,`docs/archive/aemet-avisos-resumen-manana-${fecha}.png`);
    fs.copyFileSync(pngDetalle,`docs/archive/aemet-tabla-manana-${fecha}.png`);
    const estado=estadoAvisos(await page.locator('body').innerText());
    fs.writeFileSync('docs/estado-avisos.txt',`${estado}\n`,'utf8');
    fs.writeFileSync(`docs/archive/estado-avisos-${fecha}.txt`,`${estado}\n`,'utf8');
    console.log(`Resumen generado: ${pngResumen}`);
    console.log(`Detalle generado: ${pngDetalle}`);
    console.log(`Estado: ${estado}`);
  } catch(e) {
    console.error('Error en capture-tabla.js:',e);
    process.exitCode=1;
  } finally { if(browser) await browser.close(); }
})();



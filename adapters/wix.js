// Adaptador para tiendas Wix.
//
// Wix no expone una API pública de catálogo, así que se usa el sitemap de
// productos: es un formato oficial y estable, solo lista productos publicados
// (justo lo que interesa) y pesa ~30 KB frente a 1,4 MB de una página de
// categoría. Las páginas de categoría además están paginadas y no ordenan por
// fecha, así que un producto nuevo podría no aparecer en la primera página.
//
// El detalle de cada producto solo se descarga para los que son nuevos, que es
// un evento poco frecuente.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Señales de que un producto es de Pokémon. Wix no da los nombres de las
// categorías (solo UUIDs), así que se clasifica por texto.
const POKEMON_RE =
  /pok[eé]mon|prismatic|mega evolution|megaevolution|scarlet\s*&?\s*violet|paldea|obsidian flames|temporal forces|twilight masquerade|shrouded fable|stellar crown|surging sparks|journey together|destined rivals|black bolt|white flare|pitch black|chaos rising|phantasmal flames|ascended heroes|perfect order|brilliant stars|astral radiance|lost origin|silver tempest|crown zenith|elite trainer box|\betb\b|\bsv\d{2}\b|\bswsh\d{2}\b|charizard|pikachu|eevee|charmander|lumiose|garganacl/i;

// Franquicias claramente distintas: si coincide con una de estas y no con
// Pokémon, se descarta sin ruido.
const OTRAS_FRANQUICIAS_RE =
  /one piece|dragon ball|fusion world|magic.{0,3}the gathering|\bmtg\b|secret lair|riftbound|league of legends|lorcana|shadowverse|gundam|digimon|zelda|nintendo|umamusume|hoodie|sticker|peluche|llavero/i;

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Wix respondió ${res.status} en ${url}`);
  return res.text();
}

// Lee el sitemap y devuelve la lista de productos publicados (url + fecha).
async function fetchSitemap(baseUrl) {
  const xml = await get(`${baseUrl}/store-products-sitemap.xml`);
  const entradas = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => {
    const bloque = m[1];
    const loc = /<loc>([^<]+)<\/loc>/.exec(bloque)?.[1] ?? "";
    const lastmod = /<lastmod>([^<]+)<\/lastmod>/.exec(bloque)?.[1] ?? "";
    const imagen = /<image:loc>([^<]+)<\/image:loc>/.exec(bloque)?.[1] ?? "";
    // El id es solo el slug: la URL completa acabaría en el estado, que se
    // commitea al repo público, y delataría qué tienda se está vigilando.
    const slug = loc.split("/").pop();
    return { id: slug, url: loc, lastmod, imageUrl: imagen };
  });
  if (entradas.length === 0) {
    throw new Error("El sitemap de Wix no devolvió productos (¿cambió el formato?)");
  }
  return entradas;
}

// Saca nombre y precio de la ficha del producto.
function parseFicha(html, url) {
  const crudo =
    /<meta property="og:title" content="([^"]+)"/.exec(html)?.[1] ??
    url.split("/").pop().replace(/-/g, " ");
  // og:title viene como "Producto | Nombre de la tienda": quitamos el sufijo.
  const nombre = crudo.split(" | ").slice(0, -1).join(" | ") || crudo;

  const precio = /formattedPrice\\?":\\?"([^"\\]+)/.exec(html)?.[1] ?? "";
  const sinStock = /isInStock\\?":\s*false/.test(html);

  return {
    name: nombre.trim(),
    defaultDisplayedPriceFormatted: precio,
    inStock: !sinStock,
  };
}

// Clasifica un producto ya descargado.
function clasificar(texto) {
  if (POKEMON_RE.test(texto)) return "pokemon";
  if (OTRAS_FRANQUICIAS_RE.test(texto)) return "otra";
  return "dudoso"; // no se puede decidir: se notifica marcado
}

// Interfaz común de adaptador: devuelve los productos publicados.
// `detalles(nuevos)` se llama solo con los que no estaban en el estado.
export function crearAdaptadorWix({ baseUrl, nombre, clave }) {
  return {
    nombre,
    clave,
    async listarPublicados() {
      return fetchSitemap(baseUrl);
    },
    async detallar(items) {
      const salida = [];
      for (const item of items) {
        let ficha = { name: item.url.split("/").pop().replace(/-/g, " ") };
        try {
          const html = await get(item.url);
          ficha = parseFicha(html, item.url);
          // El texto completo de la ficha ayuda a clasificar (descripciones de
          // cartas, nombres de set, etc.).
          ficha.clase = clasificar(`${ficha.name} ${html.slice(0, 400000)}`);
        } catch {
          // Si la ficha falla, no se descarta: se marca para revisar.
          ficha.clase = "dudoso";
        }
        salida.push({ ...item, ...ficha });
      }
      return salida;
    },
  };
}

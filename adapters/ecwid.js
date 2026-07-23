// Adaptador para tiendas Ecwid.
//
// Ecwid sí expone una API JSON pública de storefront, así que este adaptador es
// bastante más fiable que el de Wix: hay árbol de categorías con nombres y se
// puede resolver "qué es Pokémon" de forma estructural en vez de por texto.

const POKEMON_RE = /pok[eé]mon/i;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Ecwid respondió ${res.status}`);
  return res.json();
}

// Descarga el catálogo completo (paginado).
async function fetchAllProducts(storeId, token) {
  const base = `https://app.ecwid.com/api/v3/${storeId}/products`;
  const productos = [];
  const limit = 100;
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const url =
      `${base}?token=${token}&sortBy=ADDED_TIME_DESC&limit=${limit}&offset=${offset}` +
      `&responseFields=total,count,items(id,name,enabled,created,url,imageUrl,` +
      `defaultDisplayedPriceFormatted,categoryIds)`;
    const data = await getJson(url);
    total = data.total ?? productos.length;
    productos.push(...(data.items || []));
    if (!data.items || data.items.length === 0) break;
    offset += limit;
  }
  return productos;
}

// Ids de categorías que son (o cuelgan de) una categoría de Pokémon. Se resuelve
// en cada corrida: si la tienda crea una subcategoría nueva, entra sola.
async function fetchPokemonCategoryIds(storeId, token) {
  const url =
    `https://app.ecwid.com/api/v3/${storeId}/categories?token=${token}` +
    `&limit=100&responseFields=items(id,name,parentId)`;
  const { items = [] } = await getJson(url);
  const byId = new Map(items.map((c) => [c.id, c]));

  const esPokemon = (cat) => {
    let actual = cat;
    const vistos = new Set();
    while (actual && !vistos.has(actual.id)) {
      vistos.add(actual.id);
      if (POKEMON_RE.test(actual.name || "")) return true;
      actual = actual.parentId ? byId.get(actual.parentId) : null;
    }
    return false;
  };

  return new Set(items.filter(esPokemon).map((c) => c.id));
}

export function crearAdaptadorEcwid({ storeId, token, nombre, clave }) {
  let pokeCats = null;

  return {
    nombre,
    clave,

    // Solo los productos VISIBLES. Los ocultos llegan sin nombre ni enabled; si
    // se guardaran como vistos, al publicarse (caso típico de una pre-orden) ya
    // no se detectarían como nuevos.
    async listarPublicados() {
      const productos = await fetchAllProducts(storeId, token);
      return productos.filter((p) => p.enabled && p.name);
    },

    async detallar(items) {
      pokeCats ??= await fetchPokemonCategoryIds(storeId, token);
      return items.map((p) => {
        const enCategoria = (p.categoryIds || []).some((c) => pokeCats.has(c));
        const porNombre = POKEMON_RE.test(p.name || "");
        const sinCategoria = !(p.categoryIds || []).length;

        let clase = "otra";
        if (enCategoria || porNombre) clase = "pokemon";
        // Sin categoría no se puede clasificar: se notifica marcado en vez de
        // descartarlo en silencio, que es como se escaparía uno.
        else if (sinCategoria) clase = "dudoso";

        return { ...p, clase };
      });
    },
  };
}

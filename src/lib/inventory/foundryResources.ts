import type {
  FoundryData,
  ItemDbEntry,
  RawInventoryData,
  RecipeIngredient,
  Resource,
} from "../../types/inventory.js";
import { isResourceItem, resolveItem } from "./itemClassification.js";

function parseCompletionDate(value: unknown): Date | null {
  if (!value) return null;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "object") {
    const dateValue =
      (value as { $date?: { $numberLong?: string } | string | number }).$date ?? value;
    if (typeof dateValue === "object" && dateValue !== null && "$numberLong" in dateValue) {
      const ms = Number((dateValue as { $numberLong: string }).$numberLong);
      if (Number.isFinite(ms)) return new Date(ms);
      return null;
    }
    const date = new Date(dateValue as string | number);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** Canonical display order, shared by the Foundry tabs and the Full Sets chips. */
export const EQUIPMENT_CATEGORY_ORDER = [
  "Warframe",
  "Primary",
  "Secondary",
  "Melee",
  "Archwing",
  "Companion",
  "Appearance",
  "Gear",
  "Modular",
  "Misc",
];

// Exported because the Full Sets category chips bucket sets the same way.
// Prefers productCategory, raw category, then path fallbacks; component blueprints
// inherit their parent's category because their raw category is Resource.
export function classifyForFoundry(
  productUn: string | null,
  blueprintUn: string,
  itemDb: Record<string, ItemDbEntry>,
): string {
  const productEntry = productUn ? itemDb[productUn] : null;
  const productCategory = String(productEntry?.productCategory ?? "").toLowerCase();
  const category = String(productEntry?.category ?? "").toLowerCase();

  const parentUn = productEntry?.componentOf;
  const parentEntry = parentUn ? itemDb[parentUn] : null;
  const parentCategory = String(parentEntry?.category ?? "").toLowerCase();
  const parentProductCategory = String(parentEntry?.productCategory ?? "").toLowerCase();

  const joinedPath = `${productUn ?? ""} ${parentUn ?? ""} ${blueprintUn}`.toLowerCase();

  // Modular first (most specific).
  if (/\/(kdrives|zaws|kitguns|hoverboard|moapets)\//.test(joinedPath)) return "Modular";

  // Pet parts (Infested critter mutagens etc.) carry PEP productCategory
  // "Pistols" which would wrongly bucket them as Secondary. Path wins.
  if (/\/(pets|creaturepets|catbrowpets|kubrowpets|sentinels)\//.test(joinedPath))
    return "Companion";

  // Archwing (before Warframe to catch SpaceSuits etc.).
  if (
    productCategory === "spacesuits" ||
    productCategory === "spaceguns" ||
    productCategory === "spacemelee" ||
    parentProductCategory === "spacesuits" ||
    parentProductCategory === "spaceguns" ||
    parentProductCategory === "spacemelee" ||
    category.startsWith("arch") ||
    parentCategory.startsWith("arch") ||
    /\/(archwing|spacesuits|spaceguns|spacemelee)\//.test(joinedPath)
  )
    return "Archwing";

  // Warframe.
  if (
    productCategory === "suits" ||
    productCategory === "mechsuits" ||
    parentProductCategory === "suits" ||
    parentProductCategory === "mechsuits" ||
    category === "warframe" ||
    category === "warframes" ||
    parentCategory === "warframe" ||
    parentCategory === "warframes" ||
    /\/(warframerecipes|powersuits)\//.test(joinedPath)
  )
    return "Warframe";

  // Companion.
  if (
    productCategory === "sentinels" ||
    productCategory === "kubrowpets" ||
    parentProductCategory === "sentinels" ||
    parentProductCategory === "kubrowpets" ||
    category === "companion" ||
    category === "sentinels" ||
    category === "pets" ||
    parentCategory === "companion" ||
    /\/(sentinels|kubrowpets|catbrowpets)\//.test(joinedPath)
  )
    return "Companion";

  // Weapon slot split uses productCategory since PEP's raw category is "Weapon".
  if (
    productCategory === "longguns" ||
    parentProductCategory === "longguns" ||
    category === "primary" ||
    parentCategory === "primary"
  )
    return "Primary";
  if (
    productCategory === "pistols" ||
    parentProductCategory === "pistols" ||
    category === "secondary" ||
    parentCategory === "secondary"
  )
    return "Secondary";
  if (
    productCategory === "melee" ||
    parentProductCategory === "melee" ||
    category === "melee" ||
    parentCategory === "melee"
  )
    return "Melee";

  if (category === "gear" || parentCategory === "gear" || /\/gear\//.test(joinedPath))
    return "Gear";
  if (category === "cosmetic" || category === "appearance" || /\/customs\//.test(joinedPath))
    return "Appearance";

  return "Misc";
}

export function parseFoundry(
  data: RawInventoryData,
  itemDb: Record<string, ItemDbEntry>,
): FoundryData {
  const building: FoundryData["building"] = [];
  const recipes: FoundryData["recipes"] = [];

  const blueprintToProduct = new Map<string, string>();
  const ingredientSet = new Set<string>();
  for (const [productUn, entry] of Object.entries(itemDb)) {
    const recipe = entry?.recipe;
    if (!recipe) continue;
    if (recipe.blueprintUniqueName) {
      blueprintToProduct.set(recipe.blueprintUniqueName, productUn);
    }
    for (const ing of recipe.ingredients || []) {
      if (ing?.uniqueName) ingredientSet.add(ing.uniqueName);
    }
  }

  /** Resolve the *product* being built from a blueprint ItemType, falling back
   *  to the recipe entry itself if we can't map it. */
  function resolveProduct(blueprintItemType: string): {
    name: string;
    imageUrl: string | null;
    displayName?: string;
    productUniqueName: string | null;
    category: string;
  } {
    const productUn = blueprintToProduct.get(blueprintItemType) ?? null;
    const category = classifyForFoundry(productUn, blueprintItemType, itemDb);
    if (productUn) {
      const resolved = resolveItem(productUn, itemDb);
      return {
        name: resolved.name,
        ...(resolved.displayName ? { displayName: resolved.displayName } : {}),
        imageUrl: resolved.imageUrl ?? null,
        productUniqueName: productUn,
        category,
      };
    }
    const resolved = resolveItem(blueprintItemType, itemDb);
    return {
      // Strip a trailing "Blueprint" word so the card reads like the product.
      name: resolved.name.replace(/\s+Blueprint\s*$/i, "").trim() || resolved.name,
      ...(resolved.displayName ? { displayName: resolved.displayName } : {}),
      imageUrl: resolved.imageUrl ?? null,
      productUniqueName: null,
      category,
    };
  }

  // Prefer the product recipe; unmapped standalone blueprints may carry their own.
  function resolveRecipeDetails(
    productUn: string | null,
    blueprintUn: string,
  ): { ingredients: RecipeIngredient[]; buildPrice: number; buildTime: number } {
    const src = (productUn && itemDb[productUn]?.recipe) || itemDb[blueprintUn]?.recipe || null;
    if (!src) return { ingredients: [], buildPrice: 0, buildTime: 0 };
    return {
      ingredients: src.ingredients ?? [],
      buildPrice: typeof src.buildPrice === "number" ? src.buildPrice : 0,
      buildTime: typeof src.buildTime === "number" ? src.buildTime : 0,
    };
  }

  for (const recipe of data.PendingRecipes || []) {
    if (!recipe?.ItemType) continue;
    const blueprintUn = recipe.ItemType;
    const product = resolveProduct(blueprintUn);
    const details = resolveRecipeDetails(product.productUniqueName, blueprintUn);
    building.push({
      name: product.name,
      ...(product.displayName ? { displayName: product.displayName } : {}),
      imageUrl: product.imageUrl,
      endDate: parseCompletionDate(recipe.CompletionDate),
      uniqueName: blueprintUn,
      productUniqueName: product.productUniqueName,
      category: product.category,
      ingredients: details.ingredients,
      buildPrice: details.buildPrice,
    });
  }

  for (const recipe of data.Recipes || []) {
    if (!recipe?.ItemType) continue;
    const blueprintUn = recipe.ItemType;
    const product = resolveProduct(blueprintUn);
    const productUn = product.productUniqueName;
    const details = resolveRecipeDetails(productUn, blueprintUn);
    recipes.push({
      name: product.name,
      ...(product.displayName ? { displayName: product.displayName } : {}),
      imageUrl: product.imageUrl,
      count: typeof recipe.ItemCount === "number" ? recipe.ItemCount : 1,
      uniqueName: blueprintUn,
      productUniqueName: productUn,
      isIngredient: productUn
        ? ingredientSet.has(productUn) && !itemDb[productUn]?.componentOf
        : false,
      category: product.category,
      ingredients: details.ingredients,
      buildPrice: details.buildPrice,
      buildTime: details.buildTime,
    });
  }

  return { building, recipes };
}

export function parseResources(
  data: RawInventoryData,
  itemDb: Record<string, ItemDbEntry>,
): Resource[] {
  const resources = (data.MiscItems || [])
    .map((item) => {
      const internalName = item.ItemType || "";
      const resolved = resolveItem(internalName, itemDb);
      const dbEntry = itemDb[internalName] || {};
      if (!isResourceItem(internalName, dbEntry, resolved)) return null;

      return {
        name: resolved.name,
        ...(resolved.displayName ? { displayName: resolved.displayName } : {}),
        imageUrl: resolved.imageUrl ?? null,
        internalName,
        count: typeof item.ItemCount === "number" ? item.ItemCount : 0,
      };
    })
    .filter((item): item is Resource => item != null);

  return resources.sort((a, b) => b.count - a.count);
}

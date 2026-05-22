# Styles dynamiques

Un style dynamique est un fichier JSON qui décrit comment dessiner les features
d'une couche. Il sert surtout à répondre à trois questions :

1. Quels objets de rendu faut-il créer ? (`static`)
2. Quelles valeurs changent selon la feature courante ? (`dynamic` ou
   expressions dans `static`)
3. Quelles valeurs faut-il mettre en cache ensemble ? (`cacheKey`)

Le style est chargé depuis `config.json` avec une entrée `type: "dynamic"` :

```json
{
  "type": "dynamic",
  "name": "world",
  "title": "World",
  "path": "config/styles/world.json",
  "options": {
    "units": "m",
    "dotsPerInch": 90
  }
}
```

`name` est le nom du style côté WMS. `path` pointe vers le fichier DynStyle.
`units` vaut `"m"` ou `"dd"` et sert au calcul de l'échelle. `dotsPerInch`
vaut `90` par défaut.

## Exemple simple

Ce style dessine les pays avec un remplissage, puis ajoute un libellé différent
pour chaque feature :

```json
{
  "title": "World",
  "cacheKey": "world-style",
  "static": {
    "world": {
      "fill": {
        "color": "rgba(56, 189, 248, 0.18)"
      },
      "stroke": {
        "color": "#334155",
        "width": 0.75
      }
    },
    "country-label": {
      "text": {
        "text": "",
        "font": "12px sans-serif",
        "fill": {
          "color": "#0f172a"
        },
        "stroke": {
          "color": "rgba(255, 255, 255, 0.9)",
          "width": 3
        }
      }
    }
  },
  "dynamic": [
    {
      "pointer": "#/country-label/text/text",
      "value": "=> F.properties?.name_fr ?? ''"
    }
  ]
}
```

Lecture rapide :

- `static.world` crée un style nommé `world` avec `fill` et `stroke`.
- `static.country-label` crée un style nommé `country-label` avec un objet
  `Text` déjà présent.
- `dynamic[0]` change seulement la propriété `text` de cet objet `Text` pour la
  feature en cours.
- Le pointeur n'est pas un chemin dans le fichier JSON. Il vise les objets
  OpenLayers créés depuis `static`.

## Modèle mental

Pour chaque feature, le moteur fait ceci :

1. Il calcule le contexte : feature, résolution, échelle, constantes et
   définitions.
2. Il calcule `cacheKey`.
3. Si cette clé n'existe pas encore, il crée les objets OpenLayers à partir de
   `static` et les met en cache.
4. Il applique les patches `dynamic` sur ces objets pour la feature courante.
5. Il rend les styles obtenus.

La conséquence importante : les valeurs placées dans `static` sont figées dans
le cache pour une `cacheKey` donnée. Si une valeur change pour chaque feature,
il faut soit l'inclure dans `cacheKey`, soit la placer dans `dynamic`.

## Static ou dynamic ?

Utilisez `static` pour la structure du style :

```json
{
  "static": {
    "roads": {
      "stroke": {
        "color": "#2563eb",
        "width": 3
      }
    }
  }
}
```

Utilisez une expression dans `static` quand la valeur ne change que pour un
petit nombre de cas et que ces cas sont inclus dans `cacheKey` :

```json
{
  "cacheKey": "=> [F.get('kind')]",
  "static": {
    "by-kind": {
      "stroke": {
        "color": "=> F.get('kind') === 'highway' ? '#dc2626' : '#2563eb'",
        "width": 3
      }
    }
  }
}
```

Utilisez `dynamic` quand la valeur change souvent, typiquement un libellé, une
taille ou une couleur propre à chaque feature :

```json
{
  "cacheKey": "=> [F.geometry?.type]",
  "static": {
    "city": {
      "image": {
        "type": "Circle",
        "radius": 6,
        "fill": { "color": "#dc2626" }
      },
      "text": {
        "text": "",
        "offsetY": -14,
        "fill": { "color": "#111827" }
      }
    }
  },
  "dynamic": [
    {
      "pointer": "#/city/text/text",
      "value": "=> F.get('name') ?? ''"
    },
    {
      "pointer": "#/city/image/radius",
      "value": "=> Number(F.get('population') ?? 0) > 1000000 ? 10 : 6"
    }
  ]
}
```

## Expressions

Une expression est une chaîne qui commence par `=>`.

```json
{
  "color": "=> F.get('status') === 'open' ? '#16a34a' : '#dc2626'"
}
```

Le code après `=>` est du JavaScript. Pour un bloc, utilisez `return` :

```json
{
  "width": "=> { const rank = Number(F.get('rank') ?? 1); return Math.max(1, 8 - rank); }"
}
```

Vous pouvez aussi écrire des conditions en tableau :

```json
{
  "color": [
    "? F.get('kind') === 'city' => '#dc2626'",
    "? F.get('kind') === 'route' => '#2563eb'",
    "default => '#334155'"
  ]
}
```

Variables disponibles :

| Nom | Usage |
| --- | --- |
| `F` | Feature courante. `F.get('name')` lit une propriété. `F.properties`, `F.geometry`, `F.id`, `F.bbox`, `F.crs` et `F.sourceRef` sont aussi disponibles. |
| `R` | Résolution courante du rendu. |
| `SCALE` | Échelle calculée. |
| `LSCALE` | Borne basse de la plage d'échelle courante. |
| `USCALE` | Borne haute de la plage d'échelle courante. |
| `C` | Constantes définies dans `constants`. |
| `D` | Définitions calculées dans `definitions`. |
| `U` | Données utilisateur passées par code à `createDynamicStyleFn`. |
| `firstOf` | Helper `firstOf(value, match1, result1, match2, result2, default?)`. |

## Patches dynamiques

`dynamic` est une liste de modifications appliquées après la création ou la
récupération du style depuis le cache.

Un patch a toujours cette forme :

```json
{
  "pointer": "#/<style>/<objet>/<propriété>",
  "value": "<nouvelle valeur>"
}
```

`pointer` dit quoi modifier. `value` dit quelle valeur écrire.

### Pointer

Un pointeur vise les objets OpenLayers déjà créés depuis `static`.

```text
#/country-label/text/text
  ┬             ┬    ┬
  │             │    └─ propriété à écrire : Text.setText(...)
  │             └────── objet à atteindre : Style.getText()
  └──────────────────── style nommé "country-label" dans static
```

Avec le style suivant :

```json
{
  "static": {
    "country-label": {
      "text": {
        "text": "",
        "font": "12px sans-serif"
      }
    }
  }
}
```

le patch correct pour changer le libellé est :

```json
{
  "pointer": "#/country-label/text/text",
  "value": "=> F.get('name') ?? ''"
}
```

Ce pointeur signifie :

1. prends le style `country-label`,
2. lis son objet `text` avec `style.getText()`,
3. écris sa propriété `text` avec `text.setText(value)`.

### L'étoile `*`

`*` remplace le nom du style et signifie "tous les styles créés par `static`".

```json
{
  "dynamic": [
    {
      "pointer": "#/*/zIndex",
      "value": "=> Number(F.get('rank') ?? 0)"
    }
  ]
}
```

Ici, le patch appelle `style.setZIndex(...)` sur tous les styles qui existent
pour la feature courante.

Autre exemple :

```json
{
  "dynamic": [
    {
      "pointer": "#/*/text/text",
      "value": "=> F.get('label') ?? ''"
    }
  ]
}
```

Ce patch essaie de modifier le texte de tous les styles. Il ne fera quelque
chose que sur les styles qui ont réellement un objet `text` dans `static`.

### Value

`value` est la valeur écrite à l'endroit indiqué par `pointer`.

Elle peut être une valeur JSON fixe :

```json
{
  "pointer": "#/roads/stroke/color",
  "value": "#dc2626"
}
```

Elle peut aussi être une expression évaluée pour chaque feature :

```json
{
  "pointer": "#/roads/stroke/width",
  "value": "=> Number(F.get('importance') ?? 1) * 2"
}
```

Elle peut enfin venir d'une définition :

```json
{
  "definitions": {
    "selectedStroke": {
      "type": "Stroke",
      "color": "#facc15",
      "width": 4
    }
  },
  "dynamic": [
    {
      "pointer": "#/selection/stroke",
      "value": "=> D.selectedStroke"
    }
  ]
}
```

### Pointeurs courants

| Pointeur | Effet |
| --- | --- |
| `#/label/text/text` | Modifie le texte d'un libellé. |
| `#/label/text/font` | Modifie la police d'un libellé. |
| `#/label/text/fill/color` | Modifie la couleur de remplissage du texte. |
| `#/polygon/fill/color` | Modifie la couleur de remplissage d'un polygone. |
| `#/polygon/stroke/color` | Modifie la couleur du contour. |
| `#/polygon/stroke/width` | Modifie l'épaisseur du contour. |
| `#/point/image/radius` | Modifie le rayon d'un symbole `Circle`. |
| `#/point/image/fill/color` | Modifie la couleur d'un symbole. |
| `#/point/zIndex` | Modifie le `zIndex` du style `point`. |
| `#/*/zIndex` | Modifie le `zIndex` de tous les styles. |

### Ce qu'il ne faut pas faire

`pointer` ne pointe pas vers le JSON source.

Ce pointeur est faux :

```json
{
  "pointer": "#/static/country-label",
  "value": "=> F.properties?.name_fr ?? ''"
}
```

Pourquoi ? Parce que le premier segment après `#/` est interprété comme le nom
d'un style créé par `static`. Ici, le moteur cherche un style nommé `static`.
Il n'existe pas, donc le patch ne s'applique pas.

Pour modifier le texte du style `country-label`, il faut viser l'objet `Text` :

```json
{
  "pointer": "#/country-label/text/text",
  "value": "=> F.properties?.name_fr ?? ''"
}
```

Autre point important : `dynamic` ne crée pas les objets manquants. Il modifie
des objets déjà créés par `static`. Donc ce patch ne peut fonctionner que si
`static.country-label.text` existe déjà.

## Static

`static` contient un ou plusieurs styles nommés. Chaque clé crée un objet
OpenLayers `Style`.

```json
{
  "static": {
    "polygon": {
      "when": "=> F.geometry?.type === 'Polygon'",
      "fill": { "color": "rgba(56, 189, 248, 0.18)" },
      "stroke": { "color": "#334155", "width": 1 }
    },
    "line": {
      "when": "=> F.geometry?.type === 'LineString'",
      "stroke": { "color": "#2563eb", "width": 3 }
    },
    "point": {
      "when": "=> F.geometry?.type === 'Point'",
      "image": {
        "type": "Circle",
        "radius": 7,
        "fill": { "color": "#dc2626" },
        "stroke": { "color": "#ffffff", "width": 2 }
      }
    }
  }
}
```

`when` est optionnel. Quand il vaut `false`, le style ou le sous-objet n'est pas
créé. Quand il est absent, il vaut `=> true`.

Un style peut contenir :

| Propriété | Rôle |
| --- | --- |
| `fill` | Remplissage des polygones. |
| `stroke` | Trait des lignes et contours de polygones. |
| `image` | Symbole des points (`Circle`, `RegularShape` ou `Icon`). |
| `text` | Libellé. |
| `zIndex` | Ordre d'affichage. |

`static` peut aussi être un tableau. Dans ce cas, les styles sont nommés `"0"`,
`"1"`, `"2"`, etc. Les pointeurs utilisent alors ces noms :

```json
{
  "dynamic": [
    { "pointer": "#/0/stroke/color", "value": "#dc2626" }
  ]
}
```

## CacheKey

`cacheKey` contrôle la réutilisation des objets de style.

```json
{
  "cacheKey": "=> [F.geometry?.type, F.get('kind')]"
}
```

Choisissez une clé qui contient les valeurs utilisées pour construire `static`.

Si `static.stroke.color` dépend de `F.get('kind')`, alors `kind` doit être dans
`cacheKey`.

Si `static.text.text` dépend du nom de chaque feature, deux solutions :

1. mettre le nom dans `cacheKey`, ce qui crée un style en cache par nom ;
2. laisser `text.text` vide dans `static`, puis le remplir avec `dynamic`.

La deuxième solution est généralement meilleure pour les libellés.

## Constants et definitions

`constants` contient des valeurs fixes accessibles via `C`.

```json
{
  "constants": {
    "colors": {
      "city": "#dc2626",
      "route": "#2563eb",
      "area": "rgba(22, 163, 74, 0.22)"
    }
  }
}
```

`definitions` contient des valeurs calculées ou des morceaux de style
réutilisables accessibles via `D`.

```json
{
  "definitions": {
    "kind": "=> F.get('kind') ?? '?'",
    "label": "=> F.get('name') ?? ''",
    "color": "=> C.colors[D.kind] ?? '#334155'",
    "halo": {
      "type": "Stroke",
      "color": "#ffffff",
      "width": 3
    },
    "labelText": {
      "type": "Text",
      "text": "",
      "font": "bold 15px sans-serif",
      "offsetY": -20,
      "fill": { "type": "Fill", "color": "#111827" },
      "stroke": "=> D.halo"
    }
  }
}
```

Les types reconnus dans une définition sont `Fill`, `Stroke`, `Icon`,
`RegularShape`, `Circle`, `Text` et `Style`.

## Propriétés racine

| Propriété | Type | Défaut | Usage |
| --- | --- | --- | --- |
| `title` | chaîne | `"Layer <name>"` | Nom lisible du style. |
| `visible` | booléen | `true` | Si `false`, aucun style n'est rendu. |
| `scales` | tableau de nombres | `[]` | Bornes d'échelle. Le style est visible pour `SCALE >= première borne` et `SCALE < dernière borne`. |
| `cacheKey` | valeur ou expression | `"DEFAULT"` | Clé de cache des styles créés depuis `static`. |
| `constants` | objet | `{}` | Valeurs fixes accessibles via `C`. |
| `definitions` | objet | `{}` | Valeurs ou sous-styles accessibles via `D`. |
| `static` | objet ou tableau | `{}` | Styles OpenLayers à créer. |
| `dynamic` | tableau | `[]` | Modifications appliquées par feature. |
| `debug` | booléen | `false` | Active les logs de cache et d'échelle. |
| `format` | chaîne | `"geojson"` | Métadonnée. |
| `group` | chaîne | nom du style | Métadonnée. |
| `id` | chaîne ou `null` | `null` | Identifiant optionnel. |
| `crs` | chaîne | `"EPSG:4326"` | Métadonnée CRS du style. |

## Objets de style

Les objets reprennent les options OpenLayers. Les propriétés courantes sont
listées ci-dessous ; les autres propriétés valides OpenLayers sont transmises au
constructeur.

### Fill

```json
{ "type": "Fill", "color": "#38bdf8" }
```

`type` est optionnel dans `static.fill`, mais utile dans `definitions`.

### Stroke

```json
{
  "type": "Stroke",
  "color": "#334155",
  "width": 2,
  "lineDash": [6, 4]
}
```

Propriétés courantes : `color`, `width`, `lineCap`, `lineJoin`, `lineDash`,
`lineDashOffset`, `miterLimit`.

### Text

```json
{
  "type": "Text",
  "step": "map",
  "declutter": "first",
  "text": "",
  "font": "12px sans-serif",
  "offsetY": -12,
  "fill": { "color": "#0f172a" },
  "stroke": { "color": "#ffffff", "width": 3 }
}
```

Propriétés courantes : `text`, `step`, `declutter`, `rank`, `font`,
`scale`, `rotation`, `rotateWithView`, `offsetX`, `offsetY`, `textAlign`,
`textBaseline`, `placement`, `fill`,
`stroke`, `backgroundFill`, `backgroundStroke`, `padding`, `overflow`.

Raccourci : si `color` est présent et `fill` absent, `color` devient
`fill.color`.

`step` est une option GeoComposer, pas une option OpenLayers native. Elle vaut
`layer` par défaut. `map` diffère le texte après toutes les couches
cartographiques ; `overlay` le dessine encore après les textes `map`. Les textes
différés sont collectés pendant le rendu normal des features : le flux n'est pas
reparcouru.

`declutter` est aussi une option GeoComposer. Elle vaut `none` par défaut.
`first` conserve le premier libellé rencontré lorsqu'il y a collision.
`rank` conserve le libellé avec le plus grand `rank` numérique ; à rang égal,
le premier rencontré gagne.

Exemple avec un rang par feature :

```json
{
  "pointer": "#/capital/text/rank",
  "value": "=> Number(F.properties?.population) || 0"
}
```

### Circle

```json
{
  "type": "Circle",
  "radius": 8,
  "fill": { "color": "#dc2626" },
  "stroke": { "color": "#ffffff", "width": 2 }
}
```

Propriétés courantes : `radius`, `fill`, `stroke`, `scale`, `rotation`,
`rotateWithView`, `displacement`.

### RegularShape

```json
{
  "type": "RegularShape",
  "points": 5,
  "radius": 10,
  "radius2": 5,
  "angle": 0,
  "fill": { "color": "#facc15" },
  "stroke": { "color": "#334155", "width": 1 }
}
```

Propriétés courantes : `points`, `radius`, `radius2`, `angle`, `fill`,
`stroke`, `scale`, `rotation`, `rotateWithView`, `displacement`.

### Icon

```json
{
  "type": "Icon",
  "src": "assets/marker.svg",
  "scale": 0.8,
  "anchor": [0.5, 1]
}
```

Propriétés courantes : `src`, `img`, `scale`, `opacity`, `rotation`,
`rotateWithView`, `anchor`, `anchorXUnits`, `anchorYUnits`, `offset`, `size`,
`color`, `displacement`.

Si `src` ou `img` est une chaîne SVG commençant par `<svg`, elle est convertie
en URL `data:image/svg+xml`.

## Couleurs avancées

`Fill.color`, `Stroke.color` et `Icon.color` acceptent aussi des objets de
gradient ou de motif.

```json
{
  "fill": {
    "color": {
      "type": "LinearGradient",
      "x0": 0,
      "y0": 0,
      "x1": 256,
      "y1": 0,
      "colorStops": [
        { "offset": 0, "color": "#ef4444" },
        { "offset": 1, "color": "#3b82f6" }
      ]
    }
  }
}
```

| Type | Propriétés |
| --- | --- |
| `LinearGradient` | `x0`, `y0`, `x1`, `y1`, `colorStops` |
| `RadialGradient` | `x0`, `y0`, `r0`, `x1`, `y1`, `r1`, `colorStops` |
| `ConicGradient` | `startAngle`, `x`, `y`, `colorStops` |
| `CanvasPattern` | `image` ou `img`, `repetition` |

`colorStops` est un tableau d'objets `{ "offset": 0..1, "color": "<css>" }`.

## Checklist de debug

Quand un patch `dynamic` ne produit rien :

1. Vérifiez que `pointer` commence par `#/`.
2. Vérifiez que le premier segment est un nom présent dans `static`, ou `*`.
3. Vérifiez que vous ne pointez pas vers le JSON source (`#/static/...` est
   presque toujours faux).
4. Vérifiez que l'objet ciblé existe déjà dans `static`. `dynamic` ne crée pas
   un `Text`, un `Fill` ou un `Stroke` absent.
5. Vérifiez le dernier segment : il doit correspondre à une propriété
   OpenLayers modifiable, par exemple `text`, `color`, `width`, `radius` ou
   `zIndex`.
6. Si une expression dans `static` change selon la feature, vérifiez que
   `cacheKey` contient les valeurs qui la font changer, ou déplacez cette
   expression dans `dynamic`.

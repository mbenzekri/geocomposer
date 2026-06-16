import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BBox, CrsCode } from '../core/geometry.js'
import { escape } from '../core/tools.js'
import { Crs } from '../core/crs.js'
import { Layer } from '../layer/layer.js'
import { Style, type NamedStyle } from '../style/style.js'
import { Tileset } from '../tileset/tileset.js'
import { Service } from './service.js'

type CatalogLink = {
  label: string
  href: string
  note?: string
}

type TileCoord = {
  z: number
  x: number
  y: number
}

type CatalogType = {
  id: string
  title: string
  count: number
  objects: CatalogObject[]
}

type CatalogObject = {
  id: string
  title: string
  summary?: string
  badges: string[]
  highlights: CatalogFact[]
  details: CatalogFact[]
  links: CatalogLink[]
}

type CatalogFact = {
  label: string
  value: string
}

type LayerCatalogService = Service & {
  getLayers(): Layer[]
  getSupportedCrs?: () => CrsCode[]
}

const WEB_MERCATOR_HALF_WORLD = 20037508.342789244

export class CatalogPage {
  matches(pathname: string): boolean {
    return pathname === '/' || pathname === '/index.html'
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    Service.setCorsHeaders(res)

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      Service.sendText(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8', req.method === 'HEAD')
      return
    }

    Service.sendText(res, 200, this.renderHtml(req), 'text/html; charset=utf-8', req.method === 'HEAD')
  }

  renderHtml(req: IncomingMessage): string {
    const types = this.catalogTypes(req)

    return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Catalogue GeoComposer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --surface: #ffffff;
      --surface-soft: #f1f5f9;
      --surface-strong: #e8f3f0;
      --border: #d7dde5;
      --text: #172033;
      --muted: #5c6678;
      --accent: #0f766e;
      --accent-soft: #e6f4f1;
      --code: #102033;
      --code-bg: #eef2f7;
      --warning: #8a5200;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 15px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    button {
      font: inherit;
    }

    a {
      color: var(--accent);
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    code {
      display: inline-block;
      max-width: 100%;
      padding: 0.08rem 0.32rem;
      border-radius: 4px;
      background: var(--code-bg);
      color: var(--code);
      font: 0.92em/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow-wrap: anywhere;
      vertical-align: baseline;
    }

    header {
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }

    .wrap {
      width: calc(100% - 24px);
      max-width: none;
      margin: 0 auto;
    }

    .top {
      padding: 26px 0 20px;
    }

    h1 {
      margin: 0 0 8px;
      font-size: clamp(1.7rem, 2.2vw, 2.35rem);
      line-height: 1.1;
      letter-spacing: 0;
    }

    h2 {
      margin: 0;
      font-size: 1.1rem;
      letter-spacing: 0;
    }

    h3 {
      margin: 0 0 6px;
      font-size: 1.15rem;
      letter-spacing: 0;
    }

    p {
      margin: 0;
    }

    .lead {
      max-width: 960px;
      color: var(--muted);
    }

    main {
      padding: 20px 0 40px;
    }

    .notice {
      border: 1px solid #e6cf9a;
      border-radius: 8px;
      background: #fff8e8;
      color: var(--warning);
      padding: 12px 14px;
      margin-bottom: 14px;
    }

    .type-switcher {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 14px;
    }

    .type-button {
      appearance: none;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
      color: var(--text);
      padding: 9px 12px;
      cursor: pointer;
    }

    .type-button.active {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: #0b4f49;
      font-weight: 650;
    }

    .type-panel {
      display: none;
    }

    .type-panel.active {
      display: block;
    }

    .workbook {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      overflow: hidden;
    }

    .workbook-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      background: var(--surface-soft);
      border-bottom: 1px solid var(--border);
    }

    .object-tabs {
      display: flex;
      gap: 0;
      overflow-x: auto;
      padding: 10px 10px 0;
      background: var(--surface-soft);
      border-bottom: 1px solid var(--border);
    }

    .object-tab {
      appearance: none;
      border: 1px solid var(--border);
      border-bottom: 0;
      border-radius: 6px 6px 0 0;
      background: var(--surface);
      color: var(--text);
      padding: 8px 11px;
      margin-right: 4px;
      white-space: nowrap;
      cursor: pointer;
    }

    .object-tab.active {
      background: var(--bg);
      color: var(--accent);
      font-weight: 650;
      position: relative;
      top: 1px;
    }

    .object-panel {
      display: none;
      padding: 16px;
      background: var(--bg);
    }

    .object-panel.active {
      display: block;
    }

    .object-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      overflow: hidden;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
    }

    .card-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 20px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(180deg, #ffffff 0%, #f6faf9 100%);
    }

    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
    }

    .badge,
    .chip {
      display: inline-block;
      border-radius: 999px;
      background: var(--accent-soft);
      color: #0b4f49;
      padding: 3px 8px;
      font-size: 0.84rem;
      white-space: nowrap;
    }

    .card-body {
      padding: 18px 20px 20px;
    }

    .highlights {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 16px;
    }

    .highlight {
      min-width: 220px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-strong);
      padding: 10px 12px;
    }

    .label {
      display: block;
      color: var(--muted);
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      margin-bottom: 3px;
    }

    .detail-list {
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      margin-bottom: 18px;
    }

    .detail-row {
      display: flex;
      gap: 14px;
      padding: 9px 0;
      border-bottom: 1px solid var(--border);
    }

    .detail-row:last-child {
      border-bottom: 0;
    }

    .detail-row .label {
      flex: 0 0 180px;
      margin: 0;
    }

    .detail-value {
      min-width: 0;
      flex: 1 1 auto;
    }

    .links-title {
      margin: 0 0 10px;
      font-size: 1rem;
    }

    .url-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-soft);
      padding: 10px;
      margin-bottom: 10px;
    }

    .url-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }

    .copy-button {
      appearance: none;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
      color: var(--text);
      padding: 5px 9px;
      cursor: pointer;
    }

    .url-code {
      display: block;
      width: 100%;
      padding: 8px;
      white-space: normal;
    }

    .small {
      color: var(--muted);
      font-size: 0.86rem;
    }

    .empty {
      border: 1px dashed var(--border);
      border-radius: 8px;
      padding: 18px;
      color: var(--muted);
      background: var(--surface);
    }

    @media (max-width: 720px) {
      .wrap {
        width: calc(100% - 12px);
      }

      .workbook-head,
      .card-head,
      .detail-row,
      .url-card-head {
        display: block;
      }

      .detail-row .label {
        margin-bottom: 3px;
      }

      .copy-button {
        margin-top: 7px;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap top">
      <h1>Catalogue GeoComposer</h1>
      <p class="lead">Vue publique des services, couches, styles, tilesets et CRS chargés dans les registres actifs.</p>
    </div>
  </header>
  <main class="wrap">
    <p class="notice">Les sources internes ne sont pas publiées ici : pas de chemins de fichiers, de connexions, ni de détails de tables source.</p>
    <div class="type-switcher" role="tablist" aria-label="Types d'objets">
      ${types.map((type, index) => this.renderTypeButton(type, index === 0)).join('')}
    </div>
    ${types.map((type, index) => this.renderTypePanel(type, index === 0)).join('')}
  </main>
  <script>
    (() => {
      const typeButtons = [...document.querySelectorAll('[data-type-tab]')]
      const typePanels = [...document.querySelectorAll('[data-type-panel]')]

      const activateObject = (typeId, objectId) => {
        const tabs = [...document.querySelectorAll('[data-object-tab="' + typeId + '"]')]
        const panels = [...document.querySelectorAll('[data-object-panel="' + typeId + '"]')]
        for (const tab of tabs) {
          const active = tab.dataset.objectId === objectId
          tab.classList.toggle('active', active)
          tab.setAttribute('aria-selected', active ? 'true' : 'false')
        }
        for (const panel of panels) {
          panel.classList.toggle('active', panel.dataset.objectId === objectId)
        }
      }

      const activateType = (typeId) => {
        for (const button of typeButtons) {
          const active = button.dataset.typeId === typeId
          button.classList.toggle('active', active)
          button.setAttribute('aria-selected', active ? 'true' : 'false')
        }
        for (const panel of typePanels) {
          panel.classList.toggle('active', panel.dataset.typeId === typeId)
        }
        const firstObject = document.querySelector('[data-object-tab="' + typeId + '"]')
        if (firstObject) activateObject(typeId, firstObject.dataset.objectId)
      }

      for (const button of typeButtons) {
        button.addEventListener('click', () => activateType(button.dataset.typeId))
      }

      for (const button of document.querySelectorAll('[data-object-tab]')) {
        button.addEventListener('click', () => activateObject(button.dataset.objectTab, button.dataset.objectId))
      }

      for (const button of document.querySelectorAll('[data-copy]')) {
        button.addEventListener('click', async () => {
          const text = button.dataset.copy || ''
          try {
            await navigator.clipboard.writeText(text)
            button.textContent = 'Copie'
            setTimeout(() => { button.textContent = 'Copier' }, 1200)
          } catch {
            button.textContent = 'Erreur'
            setTimeout(() => { button.textContent = 'Copier' }, 1200)
          }
        })
      }

      const firstType = typeButtons[0]?.dataset.typeId
      if (firstType) activateType(firstType)
    })()
  </script>
</body>
</html>`
  }

  private catalogTypes(req: IncomingMessage): CatalogType[] {
    return [
      {
        id: 'services',
        title: 'Services',
        count: Service.registry.all.length,
        objects: this.serviceObjects(req)
      },
      {
        id: 'layers',
        title: 'Layers',
        count: Layer.registry.all.length,
        objects: this.layerObjects(req)
      },
      {
        id: 'styles',
        title: 'Styles',
        count: Style.registry.all.length,
        objects: this.styleObjects(req)
      },
      {
        id: 'crs',
        title: 'CRS',
        count: Crs.registry.all.length,
        objects: this.crsObjects()
      },
      {
        id: 'tilesets',
        title: 'Tilesets',
        count: Tileset.registry.all.length,
        objects: this.tilesetObjects(req)
      }
    ]
  }

  private serviceObjects(req: IncomingMessage): CatalogObject[] {
    return Service.registry.all.map((service) => {
      const id = service.name.toLowerCase()
      const currentUrl = Service.serviceUrl(req, service.path)
      const details: CatalogFact[] = [
        { label: 'URL actuelle', value: this.code(currentUrl) }
      ]

      if (service.onlineResource && service.onlineResource !== currentUrl) {
        details.push({ label: 'OnlineResource configuree', value: this.code(service.onlineResource) })
      }

      return {
        id,
        title: service.title || service.name,
        summary: service.abstract,
        badges: [service.name],
        highlights: [
          { label: 'Type', value: service.name },
          { label: 'Chemin', value: this.code(service.path) },
          { label: 'URL', value: this.code(currentUrl) }
        ],
        details,
        links: this.serviceLinks(req, service)
      }
    })
  }

  private layerObjects(req: IncomingMessage): CatalogObject[] {
    return Layer.registry.all.map((layer) => ({
      id: layer.name,
      title: layer.title ?? layer.name,
      summary: layer.summary,
      badges: [layer.crs, `${layer.styles.length} style${layer.styles.length > 1 ? 's' : ''}`],
      highlights: [
        { label: 'ID', value: this.code(layer.name) },
        { label: 'CRS', value: this.code(layer.crs) },
        { label: 'Emprise', value: layer.extent ? this.code(this.formatBbox(layer.extent)) : '<span class="small">Non declaree</span>' }
      ],
      details: [
        { label: 'Styles', value: this.renderStyleChips(layer.styles) },
        { label: 'Coordonnees ponctuelles', value: this.renderPointProperties(layer) },
        { label: 'API', value: this.layerApiLink(req, layer) }
      ],
      links: this.layerLinks(req, layer)
    }))
  }

  private styleObjects(req: IncomingMessage): CatalogObject[] {
    return Style.registry.all.map((style) => {
      const example = this.styleExample(req, style)
      return {
        id: style.name,
        title: style.title ?? style.name,
        summary: style.abstract,
        badges: ['STYLE'],
        highlights: [
          { label: 'ID', value: this.code(style.name) },
          { label: 'Parametre WMS', value: this.code(`STYLES=${style.name}`) }
        ],
        details: [
          {
            label: 'Exemple',
            value: example ? `<a href="${escape(example.href)}">${escape(example.label)}</a>` : '<span class="small">Aucun exemple WMS direct</span>'
          }
        ],
        links: example ? [example] : []
      }
    })
  }

  private crsObjects(): CatalogObject[] {
    return Crs.registry.all.map((crs) => ({
      id: crs.code,
      title: crs.title,
      badges: ['CRS'],
      highlights: [
        { label: 'Code', value: this.code(crs.code) },
        { label: 'Titre', value: escape(crs.title) }
      ],
      details: [
        { label: 'Nom', value: escape(crs.name) }
      ],
      links: []
    }))
  }

  private tilesetObjects(req: IncomingMessage): CatalogObject[] {
    return Tileset.registry.all.map((tileset) => ({
      id: tileset.name,
      title: tileset.title ?? tileset.name,
      summary: tileset.summary,
      badges: [tileset.crs, tileset.tileMatrixSet.id],
      highlights: [
        { label: 'ID', value: this.code(tileset.name) },
        { label: 'CRS', value: this.code(tileset.crs) },
        { label: 'Zooms', value: this.code(`${tileset.minZoom}-${tileset.maxZoom}`) },
        { label: 'Taille', value: this.code(`${tileset.tileSize}px`) }
      ],
      details: [
        { label: 'TileMatrixSet', value: this.code(tileset.tileMatrixSet.id) },
        { label: 'Formats', value: this.renderChips(tileset.formats) },
        { label: 'Layers', value: this.renderChips(tileset.layers.map((layer) => layer.name)) }
      ],
      links: this.tilesetLinks(req, tileset)
    }))
  }

  private renderTypeButton(type: CatalogType, active: boolean): string {
    return `<button class="type-button${active ? ' active' : ''}" type="button" role="tab" data-type-tab data-type-id="${escape(type.id)}" aria-selected="${active ? 'true' : 'false'}">${escape(type.title)} (${type.count})</button>`
  }

  private renderTypePanel(type: CatalogType, active: boolean): string {
    if (type.objects.length === 0) {
      return `<section class="type-panel${active ? ' active' : ''}" data-type-panel data-type-id="${escape(type.id)}">
        <div class="workbook">
          <div class="workbook-head">
            <h2>${escape(type.title)}</h2>
            <span class="small">0 objet</span>
          </div>
          <div class="object-panel active"><p class="empty">Aucun objet disponible.</p></div>
        </div>
      </section>`
    }

    return `<section class="type-panel${active ? ' active' : ''}" data-type-panel data-type-id="${escape(type.id)}">
      <div class="workbook">
        <div class="workbook-head">
          <h2>${escape(type.title)}</h2>
          <span class="small">${type.count} objet${type.count > 1 ? 's' : ''}</span>
        </div>
        <div class="object-tabs" role="tablist" aria-label="${escape(type.title)}">
          ${type.objects.map((object, index) => this.renderObjectTab(type, object, index === 0)).join('')}
        </div>
        ${type.objects.map((object, index) => this.renderObjectPanel(type, object, index === 0)).join('')}
      </div>
    </section>`
  }

  private renderObjectTab(type: CatalogType, object: CatalogObject, active: boolean): string {
    return `<button class="object-tab${active ? ' active' : ''}" type="button" role="tab" data-object-tab="${escape(type.id)}" data-object-id="${escape(object.id)}" aria-selected="${active ? 'true' : 'false'}">${escape(object.id)}</button>`
  }

  private renderObjectPanel(type: CatalogType, object: CatalogObject, active: boolean): string {
    return `<section class="object-panel${active ? ' active' : ''}" data-object-panel="${escape(type.id)}" data-object-id="${escape(object.id)}" role="tabpanel">
      ${this.renderObjectCard(object)}
    </section>`
  }

  private renderObjectCard(object: CatalogObject): string {
    const summary = object.summary ? `<p class="small">${escape(object.summary)}</p>` : ''
    const badges = object.badges.length
      ? `<div class="badges">${object.badges.map((badge) => `<span class="badge">${escape(badge)}</span>`).join('')}</div>`
      : ''

    return `<article class="object-card">
      <div class="card-head">
        <div>
          <h3>${escape(object.title)}</h3>
          <code>${escape(object.id)}</code>
          ${summary}
        </div>
        ${badges}
      </div>
      <div class="card-body">
        ${this.renderHighlights(object.highlights)}
        ${this.renderDetails(object.details)}
        ${this.renderLinkExamples(object.links)}
      </div>
    </article>`
  }

  private renderHighlights(facts: CatalogFact[]): string {
    if (facts.length === 0) return ''

    return `<div class="highlights">
      ${facts.map((fact) => `<div class="highlight">
        <span class="label">${escape(fact.label)}</span>
        <div>${fact.value}</div>
      </div>`).join('')}
    </div>`
  }

  private renderDetails(facts: CatalogFact[]): string {
    if (facts.length === 0) return ''

    return `<div class="detail-list">
      ${facts.map((fact) => `<div class="detail-row">
        <span class="label">${escape(fact.label)}</span>
        <div class="detail-value">${fact.value}</div>
      </div>`).join('')}
    </div>`
  }

  private renderLinkExamples(links: CatalogLink[]): string {
    if (links.length === 0) return ''

    return `<section>
      <h4 class="links-title">URLs exemples</h4>
      ${links.map((link) => `<div class="url-card">
        <div class="url-card-head">
          <div>
            <strong>${escape(link.label)}</strong>
            ${link.note ? `<div class="small">${escape(link.note)}</div>` : ''}
          </div>
          <button class="copy-button" type="button" data-copy="${escape(link.href)}">Copier</button>
        </div>
        <code class="url-code">${escape(link.href)}</code>
      </div>`).join('')}
    </section>`
  }

  private serviceLinks(req: IncomingMessage, service: Service): CatalogLink[] {
    switch (service.name) {
      case 'WMS':
        return this.wmsLinks(req, service)
      case 'API':
        return this.apiLinks(req, service)
      case 'XYZ':
        return this.xyzLinks(req, service)
      case 'WMTS':
        return this.wmtsLinks(req, service)
      default:
        return [{ label: 'URL du service', href: Service.serviceUrl(req, service.path) }]
    }
  }

  private wmsLinks(req: IncomingMessage, service: Service): CatalogLink[] {
    const links: CatalogLink[] = [
      {
        label: 'GetCapabilities',
        href: this.url(req, service.path, { SERVICE: 'WMS', REQUEST: 'GetCapabilities' })
      }
    ]
    const layer = this.firstLayer(service)

    if (layer) {
      const style = layer.styles[0]?.name ?? 'default'
      const crs = this.serviceCrs(service, layer)
      const bbox = this.sampleBbox(layer, crs, true)
      const common = {
        SERVICE: 'WMS',
        VERSION: '1.3.0',
        LAYERS: layer.name,
        STYLES: style,
        CRS: crs,
        BBOX: bbox.join(','),
        WIDTH: '800',
        HEIGHT: '400'
      }

      links.push({
        label: 'GetMap exemple',
        href: this.url(req, service.path, {
          ...common,
          REQUEST: 'GetMap',
          FORMAT: 'image/png'
        }),
        note: `layer=${layer.name}, style=${style}`
      })
      links.push({
        label: 'GetFeatureInfo exemple',
        href: this.url(req, service.path, {
          ...common,
          REQUEST: 'GetFeatureInfo',
          QUERY_LAYERS: layer.name,
          FORMAT: 'image/png',
          INFO_FORMAT: 'application/geo+json',
          I: '400',
          J: '200',
          FEATURE_COUNT: '5'
        }),
        note: `query layer=${layer.name}`
      })
    }

    return links
  }

  private apiLinks(req: IncomingMessage, service: Service): CatalogLink[] {
    const links: CatalogLink[] = [
      { label: 'Landing JSON', href: Service.serviceUrl(req, service.path) },
      { label: 'OpenAPI', href: Service.serviceUrl(req, `${service.path}/api`) },
      { label: 'Conformance', href: Service.serviceUrl(req, `${service.path}/conformance`) },
      { label: 'Collections', href: Service.serviceUrl(req, `${service.path}/collections`) }
    ]
    const layer = this.firstLayer(service)

    if (layer) {
      links.push({
        label: 'Items GeoJSON exemple',
        href: this.url(req, `${service.path}/collections/${encodeURIComponent(layer.name)}/items`, {
          limit: '10',
          crs: this.serviceCrs(service, layer)
        }),
        note: `collection=${layer.name}`
      })
    }

    return links
  }

  private xyzLinks(req: IncomingMessage, service: Service): CatalogLink[] {
    const tileset = this.firstTileset()
    if (!tileset) {
      return [{ label: 'Chemin XYZ', href: Service.serviceUrl(req, service.path), note: 'Aucun tileset configure' }]
    }

    const coord = this.sampleTileCoord(tileset)
    const output = tileset.outputs[0]
    const links: CatalogLink[] = [
      {
        label: 'Template',
        href: `${Service.serviceUrl(req, service.path)}/{tileset}/{z}/{x}/{y}.${output.extension}`,
        note: 'Remplacer les variables entre accolades'
      },
      {
        label: 'Tile exemple',
        href: Service.serviceUrl(
          req,
          `${service.path}/${encodeURIComponent(tileset.name)}/${coord.z}/${coord.x}/${coord.y}.${output.extension}`
        ),
        note: `tileset=${tileset.name}, format=${output.format}`
      }
    ]

    if (!output.vector) {
      links.push({
        label: 'Tile retina exemple',
        href: Service.serviceUrl(
          req,
          `${service.path}/${encodeURIComponent(tileset.name)}/${coord.z}/${coord.x}/${coord.y}@2x.${output.extension}`
        )
      })
    }

    return links
  }

  private wmtsLinks(req: IncomingMessage, service: Service): CatalogLink[] {
    const links: CatalogLink[] = [
      {
        label: 'GetCapabilities',
        href: this.url(req, service.path, { SERVICE: 'WMTS', REQUEST: 'GetCapabilities' })
      }
    ]
    const tileset = this.firstTileset()

    if (tileset) {
      const coord = this.sampleTileCoord(tileset)
      links.push({
        label: 'GetTile exemple',
        href: this.url(req, service.path, {
          SERVICE: 'WMTS',
          REQUEST: 'GetTile',
          VERSION: '1.0.0',
          LAYER: tileset.name,
          STYLE: 'default',
          TILEMATRIXSET: tileset.tileMatrixSet.id,
          TILEMATRIX: tileset.tileMatrixSet.matrixId(coord.z),
          TILEROW: String(coord.y),
          TILECOL: String(coord.x),
          FORMAT: tileset.defaultFormat
        }),
        note: `tileset=${tileset.name}`
      })
    }

    return links
  }

  private layerLinks(req: IncomingMessage, layer: Layer): CatalogLink[] {
    const links: CatalogLink[] = []
    const api = Service.registry.all.find((service) => service.name === 'API')
    const wms = Service.registry.all.find((service) => service.name === 'WMS')

    if (api && this.serviceLayers(api).some((entry) => entry.name === layer.name)) {
      links.push({
        label: 'Collection API',
        href: Service.serviceUrl(req, `${api.path}/collections/${encodeURIComponent(layer.name)}`)
      })
      links.push({
        label: 'Items API',
        href: this.url(req, `${api.path}/collections/${encodeURIComponent(layer.name)}/items`, {
          limit: '10',
          crs: this.serviceCrs(api, layer)
        })
      })
    }

    if (wms && this.serviceLayers(wms).some((entry) => entry.name === layer.name)) {
      const style = layer.styles[0]?.name ?? 'default'
      const crs = this.serviceCrs(wms, layer)
      links.push({
        label: 'GetMap WMS',
        href: this.url(req, wms.path, {
          SERVICE: 'WMS',
          VERSION: '1.3.0',
          REQUEST: 'GetMap',
          LAYERS: layer.name,
          STYLES: style,
          CRS: crs,
          BBOX: this.sampleBbox(layer, crs, true).join(','),
          WIDTH: '800',
          HEIGHT: '400',
          FORMAT: 'image/png'
        })
      })
    }

    return links
  }

  private styleExample(req: IncomingMessage, style: NamedStyle): CatalogLink | null {
    const wms = Service.registry.all.find((service) => service.name === 'WMS')
    if (!wms) return null

    const layer = this.serviceLayers(wms).find((entry) => entry.styles.some((candidate) => candidate.name === style.name))
    if (!layer) return null
    const crs = this.serviceCrs(wms, layer)

    return {
      label: 'GetMap avec ce style',
      href: this.url(req, wms.path, {
        SERVICE: 'WMS',
        VERSION: '1.3.0',
        REQUEST: 'GetMap',
        LAYERS: layer.name,
        STYLES: style.name,
        CRS: crs,
        BBOX: this.sampleBbox(layer, crs, true).join(','),
        WIDTH: '800',
        HEIGHT: '400',
        FORMAT: 'image/png'
      }),
      note: `layer=${layer.name}`
    }
  }

  private tilesetLinks(req: IncomingMessage, tileset: Tileset): CatalogLink[] {
    const links: CatalogLink[] = []
    const xyz = Service.registry.all.find((service) => service.name === 'XYZ')
    const wmts = Service.registry.all.find((service) => service.name === 'WMTS')
    const coord = this.sampleTileCoord(tileset)

    if (xyz) {
      const output = tileset.outputs[0]
      links.push({
        label: 'XYZ exemple',
        href: Service.serviceUrl(
          req,
          `${xyz.path}/${encodeURIComponent(tileset.name)}/${coord.z}/${coord.x}/${coord.y}.${output.extension}`
        ),
        note: output.format
      })
    }

    if (wmts) {
      links.push({
        label: 'WMTS exemple',
        href: this.url(req, wmts.path, {
          SERVICE: 'WMTS',
          REQUEST: 'GetTile',
          VERSION: '1.0.0',
          LAYER: tileset.name,
          STYLE: 'default',
          TILEMATRIXSET: tileset.tileMatrixSet.id,
          TILEMATRIX: tileset.tileMatrixSet.matrixId(coord.z),
          TILEROW: String(coord.y),
          TILECOL: String(coord.x),
          FORMAT: tileset.defaultFormat
        })
      })
    }

    return links
  }

  private layerApiLink(req: IncomingMessage, layer: Layer): string {
    const api = Service.registry.all.find((service) => service.name === 'API')
    if (!api) return '<span class="small">API non configuree</span>'
    if (!this.serviceLayers(api).some((entry) => entry.name === layer.name)) {
      return '<span class="small">Non publie par API</span>'
    }

    const href = Service.serviceUrl(req, `${api.path}/collections/${encodeURIComponent(layer.name)}`)
    return `<a href="${escape(href)}">collection</a>`
  }

  private renderStyleChips(styles: readonly NamedStyle[]): string {
    if (styles.length === 0) return '<span class="small">Aucun</span>'

    const chips = styles.map((style) => `<span class="chip">${escape(style.name)}</span>`)
    return `<div>${chips.join(' ')}</div>`
  }

  private renderPointProperties(layer: Layer): string {
    if (layer.pointProperties.length === 0) return '<span class="small">Aucune</span>'

    return this.renderChips(layer.pointProperties.map((entry) => `${entry.x}/${entry.y} (${entry.crs})`))
  }

  private renderChips(values: readonly string[]): string {
    if (values.length === 0) return '<span class="small">Aucun</span>'

    return `<div>${values.map((value) => `<span class="chip">${escape(value)}</span>`).join(' ')}</div>`
  }

  private code(value: string): string {
    return `<code>${escape(value)}</code>`
  }

  private url(req: IncomingMessage, path: string, params: Record<string, string>): string {
    const url = new URL(Service.serviceUrl(req, path))

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }

    return url.toString()
  }

  private firstLayer(service?: Service): Layer | undefined {
    return this.serviceLayers(service)[0]
  }

  private firstTileset(): Tileset | undefined {
    return Tileset.registry.all[0]
  }

  private serviceLayers(service?: Service): Layer[] {
    if (service && this.isLayerCatalogService(service)) {
      return service.getLayers()
    }

    return Layer.registry.all
  }

  private serviceCrs(service: Service, layer: Layer): CrsCode {
    const supportedCrs = this.isLayerCatalogService(service) && service.getSupportedCrs
      ? service.getSupportedCrs()
      : []
    if (supportedCrs.length === 0) return layer.crs
    if (supportedCrs.includes(layer.crs)) return layer.crs
    if (supportedCrs.includes('EPSG:4326')) return 'EPSG:4326'
    return supportedCrs[0] ?? layer.crs
  }

  private isLayerCatalogService(service: Service): service is LayerCatalogService {
    return typeof (service as Partial<LayerCatalogService>).getLayers === 'function'
  }

  private sampleBbox(layer: Layer, crs: CrsCode, wmsAxisOrder: boolean): BBox {
    const bbox = layer.crs === crs
      ? layer.extent ?? this.defaultBbox(crs)
      : this.defaultBbox(crs)

    if (wmsAxisOrder && crs.toUpperCase() === 'EPSG:4326') {
      return [bbox[1], bbox[0], bbox[3], bbox[2]]
    }

    return bbox
  }

  private defaultBbox(crs: CrsCode): BBox {
    if (crs.toUpperCase() === 'EPSG:3857') {
      return [-WEB_MERCATOR_HALF_WORLD, -WEB_MERCATOR_HALF_WORLD, WEB_MERCATOR_HALF_WORLD, WEB_MERCATOR_HALF_WORLD]
    }

    if (crs.toUpperCase() === 'EPSG:4326') {
      return [-180, -90, 180, 90]
    }

    return [0, 0, 1, 1]
  }

  private sampleTileCoord(tileset: Tileset): TileCoord {
    const z = Math.min(Math.max(1, tileset.minZoom), tileset.maxZoom)
    const maxCoord = 2 ** z - 1
    const coord = Math.min(1, maxCoord)
    return { z, x: coord, y: coord }
  }

  private formatBbox(bbox: BBox): string {
    return bbox.map((value) => this.formatNumber(value)).join(', ')
  }

  private formatNumber(value: number): string {
    if (!Number.isFinite(value)) return String(value)
    return Number.parseFloat(value.toFixed(6)).toString()
  }

}

// dsh-senior-adviser — browser half ("上级顾问" settings card).
//
// Why this file exists at all (see 00-取证.md U3): the generated settings form
// serializes the plugin's Config schema, so its option lists are static
// literals; and this build ships no generic form renderer that consumes
// `autoGenerate`. The provider/model dropdowns must follow the LIVE registry,
// which only a client bundle can do — hence a real card.
//
// Where the card lives (2026-11-13): inside the dsh-plugin-hub sidebar panel
// (`plugin-hub.sections` slot, id `plugin-hub.adviser`), not Settings → Built-in
// plugins. If the hub panel is absent, the card simply does not render — the
// tool itself is unaffected (it is registered by the host half, lib/index.js).
//
// Every value read here comes from an existing host seam:
//   providers  <- remote.llm.listProviders()
//   models     <- remote.session.modelCatalog()          (provider-grouped)
//   declared window <- remote.settings.describe() on the provider's own
//                       settings namespace (found via listConfigurableProviders)
//   values/revision/writes <- configForms.get('senior-adviser')
// The card never invents a model, never stores a key, never writes a file.

window.__ModuleLoader__.load({
  id: 'dsh-senior-adviser',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const NS = 'settings.seniorAdviser'
    const SETTINGS_NS = 'senior-adviser'

    const zh = {
      tab: '上级顾问',
      title: '上级顾问（senior-adviser）',
      intro:
        '阻塞式咨询模型：它没有工具、看不见本地文件，只根据你贴给它的内容判断。一次 ask_senior 占住整个回合，直到顾问说完。',
      provider: '服务商',
      model: '模型',
      providerHint: '来自 ctx.llm.listProviders()，只列当前已注册的路由。',
      modelHint: '随服务商变化，来自运行时模型目录；不支持手填。',
      contextWindow: '上下文窗口（只读）',
      contextWindowFollow: '跟随模型',
      contextWindowDeclared: '模型声明',
      contextWindowRuntime: '运行时（resolveModelInfo 回显）',
      contextWindowUnknown: '未声明',
      overridden: (declared, value) => `已从 ${declared} 覆盖为 ${value}`,
      overrideHint: '留空或填 0 = 跟随模型；填 >0 = 覆盖。',
      maxTokens: '单次输出上限',
      maxTokensHint: '0 = 使用模型的 defaultMaxTokens。',
      historyTurns: '附带历史轮数',
      reasoningEffort: '推理等级',
      reasoningEffortHint: '随模型变化，来自模型元数据 reasoning.efforts；默认 = 模型默认推理等级。',
      reasoningEffortDefault: '模型默认',
      maxRounds: '轮次上限',
      maxRoundsHint: '超过后 ask_senior 直接返回 ROUNDS_EXHAUSTED，不发起任何请求。',
      persona: '人设（五条原则）',
      personaHint: '契约段由插件追加，不在这里改。留空 = 使用内置。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      conflict: '写入被拒绝（SETTINGS_CONFLICT）：配置已被另一个窗口改动，面板已重新读取，请重试。',
      failed: (message) => `写入失败：${message}`,
      loading: '读取中…',
      unavailable: '设置服务不可用（此页面必须由本机 Host 提供）。',
      noProviders: '当前没有已注册的模型服务商。',
      noModels: '该服务商没有可用模型。'
    }

    const en = {
      tab: 'Senior adviser',
      title: 'Senior adviser (senior-adviser)',
      intro:
        'A blocking consult model: no tools, no local files — it only judges what you hand it. One ask_senior call owns the whole turn.',
      provider: 'Provider',
      model: 'Model',
      providerHint: 'From ctx.llm.listProviders(): only registered routes.',
      modelHint: 'Follows the provider, from the live model catalog; no free text.',
      contextWindow: 'Context window (read-only)',
      contextWindowFollow: 'Follow model',
      contextWindowDeclared: 'Declared',
      contextWindowRuntime: 'Runtime (resolveModelInfo echo)',
      contextWindowUnknown: 'undeclared',
      overridden: (declared, value) => `overridden: ${declared} → ${value}`,
      overrideHint: 'Empty or 0 = follow the model; >0 = override.',
      maxTokens: 'Max output tokens',
      maxTokensHint: '0 = the model defaultMaxTokens.',
      historyTurns: 'History turns',
      reasoningEffort: 'Reasoning effort',
      reasoningEffortHint: 'Follows the model, from its reasoning.efforts metadata; default = model default.',
      reasoningEffortDefault: 'Model default',
      maxRounds: 'Round cap',
      maxRoundsHint: 'Past the cap ask_senior answers ROUNDS_EXHAUSTED without a request.',
      persona: 'Persona (five principles)',
      personaHint: 'The contract paragraph is appended by the plugin. Empty = built-in.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      conflict: 'Write refused (SETTINGS_CONFLICT): changed by another window; reloaded — try again.',
      failed: (message) => `Write failed: ${message}`,
      loading: 'Loading…',
      unavailable: 'Settings unavailable (this page must be served by a local Host).',
      noProviders: 'No registered model provider.',
      noModels: 'This provider has no usable model.'
    }

    const inject = [
      'slots',
      'locale',
      'configForms',
      'remote',
      'remote.llm',
      'remote.session',
      'remote.settings'
    ]

    // ── small utilities ───────────────────────────────────────────────────
    function pathValue(root, path) {
      let current = root
      for (const key of path) {
        if (current === null || current === undefined) return undefined
        current = current[key]
      }
      return current
    }

    function toNumber(text) {
      const trimmed = String(text).trim()
      if (trimmed.length === 0) return 0
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? parsed : 0
    }

    function formatWindow(value) {
      return typeof value === 'number' && value > 0 ? value.toLocaleString('en-US') : null
    }

    const styles = {
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        maxWidth: 760,
        color: 'var(--dsw-alias-label-primary)'
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '14px 16px',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        borderRadius: 'var(--dsw-radius-xl)',
        background: 'var(--dsw-alias-settings-card-fill)'
      },
      row: { display: 'grid', gridTemplateColumns: '160px minmax(0,1fr)', gap: 10, alignItems: 'start' },
      label: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', marginTop: 4 },
      control: {
        font: 'inherit',
        fontSize: 13,
        lineHeight: '20px',
        padding: '6px 8px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md)',
        width: '100%',
        boxSizing: 'border-box'
      },
      readonly: {
        fontFamily: 'var(--ds-font-family-code)',
        fontSize: 13,
        lineHeight: '20px',
        padding: '6px 8px',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-secondary)'
      },
      badge: {
        display: 'inline-block',
        marginLeft: 8,
        padding: '0 6px',
        borderRadius: 'var(--dsw-radius-xs)',
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 11,
        lineHeight: '18px'
      },
      title: { margin: 0, fontSize: 18, fontWeight: 600 },
      intro: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },
      status: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      error: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' }
    }

    function Row(props) {
      return React.createElement(
        'div',
        { style: styles.row },
        React.createElement('div', { style: styles.label }, props.label, props.badge === undefined ? null : React.createElement('span', { style: styles.badge }, props.badge)),
        React.createElement(
          'div',
          null,
          props.children,
          props.hint === undefined ? null : React.createElement('div', { style: styles.hint }, props.hint)
        )
      )
    }

    function SeniorAdviserCard(props) {
      const { t, form, listProviders, loadModels, loadDeclared } = props
      const snapshot = React.useSyncExternalStore(
        (listener) => form.subscribe(listener),
        () => form.getSnapshot(),
        () => form.getSnapshot()
      )

      const [providers, setProviders] = React.useState([])
      const [groups, setGroups] = React.useState([])
      const [declared, setDeclared] = React.useState({})
      const [loadError, setLoadError] = React.useState(null)
      const [writeState, setWriteState] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        Promise.all([listProviders(), loadModels(), loadDeclared()])
          .then(([providerRows, catalog, windows]) => {
            if (!alive) return
            setProviders(providerRows)
            setGroups(catalog)
            setDeclared(windows)
          })
          .catch((error) => {
            if (alive) setLoadError(error instanceof Error ? error.message : String(error))
          })
        return () => {
          alive = false
        }
      }, [listProviders, loadModels, loadDeclared])

      const value = snapshot.value === undefined || snapshot.value === null ? {} : snapshot.value
      const user = snapshot.user === undefined || snapshot.user === null ? {} : snapshot.user

      if (snapshot.status === 'unavailable') {
        return React.createElement('div', { style: styles.section }, React.createElement('p', { style: styles.error }, t('unavailable')))
      }
      if (snapshot.status === 'loading' && snapshot.value === undefined) {
        return React.createElement('div', { style: styles.section }, React.createElement('p', { style: styles.status }, t('loading')))
      }

      const selectedProvider = String(value.provider || '')
      const selectedModel = String(value.model || '')
      const group = groups.find((item) => item.id === selectedProvider)
      const models = group === undefined ? [] : group.models
      const selectedCatalogModel = models.find((model) => model.id === selectedModel)
      const efforts =
        selectedCatalogModel === undefined || selectedCatalogModel.reasoning === undefined
          ? []
          : Array.isArray(selectedCatalogModel.reasoning.efforts)
            ? selectedCatalogModel.reasoning.efforts
            : []
      const declaredKey = selectedProvider + '/' + selectedModel
      const declaredWindow = declared[declaredKey]
      const configuredWindow = Number(value.contextWindow || 0)
      const effectiveWindow = configuredWindow > 0 ? configuredWindow : declaredWindow
      const declaredText = formatWindow(declaredWindow)
      const effectiveText = formatWindow(effectiveWindow)

      const write = (field, next) => {
        setWriteState({ kind: 'saving' })
        form
          .set(field, next)
          .then((accepted) => {
            setWriteState(accepted === true ? { kind: 'saved' } : { kind: 'conflict' })
          })
          .catch((error) => {
            setWriteState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
          })
      }

      const statusLine = () => {
        if (writeState === null) return null
        if (writeState.kind === 'saving' || writeState.kind === 'saved') {
          return React.createElement('p', { style: styles.status }, t(writeState.kind === 'saving' ? 'saving' : 'saved'))
        }
        if (writeState.kind === 'conflict') return React.createElement('p', { style: styles.error }, t('conflict'))
        return React.createElement('p', { style: styles.error }, t('failed')(writeState.message))
      }

      return React.createElement(
        'div',
        { style: styles.section },
        React.createElement('h2', { style: styles.title }, t('title')),
        React.createElement('p', { style: styles.intro }, t('intro')),
        loadError === null
          ? null
          : React.createElement('p', { style: styles.error }, loadError),
        React.createElement(
          'div',
          { style: styles.card },
          React.createElement(
            Row,
            { label: t('provider'), hint: t('providerHint'), badge: user.provider === undefined ? undefined : '已覆盖' },
            React.createElement(
              'select',
              {
                style: styles.control,
                value: selectedProvider,
                onChange: (event) => {
                  write('provider', event.target.value)
                  write('model', '')
                }
              },
              React.createElement('option', { value: '' }, '—'),
              providers.length === 0
                ? React.createElement('option', { value: '', disabled: true }, t('noProviders'))
                : null,
              providers.map((provider) =>
                React.createElement('option', { key: provider.id, value: provider.id }, provider.name + ' · ' + provider.id)
              )
            )
          ),
          React.createElement(
            Row,
            { label: t('model'), hint: t('modelHint'), badge: user.model === undefined ? undefined : '已覆盖' },
            React.createElement(
              'select',
              {
                style: styles.control,
                value: selectedModel,
                disabled: models.length === 0,
                onChange: (event) => {
                  write('model', event.target.value)
                }
              },
              React.createElement('option', { value: '' }, '—'),
              models.length === 0
                ? React.createElement('option', { value: '', disabled: true }, t('noModels'))
                : null,
              models.map((model) =>
                React.createElement('option', { key: model.id, value: model.id }, model.name + ' · ' + model.id)
              )
            )
          ),
          React.createElement(
            Row,
            {
              label: t('contextWindow'),
              hint:
                configuredWindow > 0
                  ? t('overridden')(declaredText === null ? t('contextWindowUnknown') : declaredText, formatWindow(configuredWindow) || '0')
                  : t('overrideHint')
            },
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              React.createElement(
                'div',
                { style: styles.readonly },
                (effectiveText === null ? t('contextWindowFollow') : effectiveText) +
                  '  ' + (configuredWindow > 0 ? '（覆盖）' : '（' + t('contextWindowDeclared') + (declaredText === null ? '：' + t('contextWindowUnknown') : '：' + declaredText) + '）')
              ),
              React.createElement('input', {
                style: styles.control,
                type: 'number',
                min: 0,
                step: 1000,
                value: String(configuredWindow),
                onChange: (event) => write('contextWindow', toNumber(event.target.value))
              })
            )
          ),
          React.createElement(
            Row,
            { label: t('maxTokens'), hint: t('maxTokensHint') },
            React.createElement('input', {
              style: styles.control,
              type: 'number',
              min: 0,
              step: 256,
              value: String(Number(value.maxTokens || 0)),
              onChange: (event) => write('maxTokens', toNumber(event.target.value))
            })
          ),
          React.createElement(
            Row,
            { label: t('historyTurns') },
            React.createElement('input', {
              style: styles.control,
              type: 'number',
              min: 0,
              max: 100,
              value: String(Number(value.historyTurns === undefined ? 10 : value.historyTurns)),
              onChange: (event) => write('historyTurns', toNumber(event.target.value))
            })
          ),
          React.createElement(
            Row,
            { label: t('reasoningEffort'), hint: t('reasoningEffortHint') },
            React.createElement(
              'select',
              {
                style: styles.control,
                value: String(value.reasoningEffort || ''),
                disabled: efforts.length === 0,
                onChange: (event) => write('reasoningEffort', event.target.value)
              },
              React.createElement('option', { value: '' }, t('reasoningEffortDefault')),
              efforts.length === 0
                ? null
                : efforts.map((effort) =>
                    React.createElement(
                      'option',
                      { key: effort.id, value: effort.id },
                      effort.name + ' · ' + effort.id
                    )
                  )
            )
          ),
          React.createElement(
            Row,
            { label: t('maxRounds'), hint: t('maxRoundsHint') },
            React.createElement('input', {
              style: styles.control,
              type: 'number',
              min: 1,
              max: 50,
              value: String(Number(value.maxRounds === undefined ? 8 : value.maxRounds)),
              onChange: (event) => write('maxRounds', toNumber(event.target.value))
            })
          ),
          React.createElement(
            Row,
            { label: t('persona'), hint: t('personaHint') },
            React.createElement('textarea', {
              style: { ...styles.control, minHeight: 120, resize: 'vertical' },
              value: String(value.persona === undefined ? '' : value.persona),
              onChange: (event) => write('persona', event.target.value)
            })
          ),
          statusLine(),
          React.createElement(
            'p',
            { style: styles.status },
            'instance: ' + SETTINGS_NS + ' · revision ' + String(snapshot.revision === undefined ? '—' : snapshot.revision) + ' · writable ' + String(snapshot.writable)
          )
        )
      )
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh,
            en
          }),
        'senior-adviser: card dictionaries'
      )
      const t = ctx.locale.bind(NS)
      const form = ctx.configForms.get(SETTINGS_NS)

      const listProviders = async () => {
        const result = await ctx.remote.llm.listProviders()
        if (result.ok !== true) throw new Error(result.error.code + ': ' + result.error.message)
        return result.value.map((row) => ({ id: row.id, name: row.name }))
      }

      const loadModels = async () => {
        const result = await ctx.remote.session.modelCatalog()
        if (result.ok !== true) throw new Error(result.error.code + ': ' + result.error.message)
        return result.value.groups
      }

      // The declared window for every provider/model, read from the provider's
      // OWN settings namespace — the same declaration resolveModelInfo reads.
      const loadDeclared = async () => {
        const [described, configurable] = await Promise.all([
          ctx.remote.settings.describe(),
          ctx.remote.llm.listConfigurableProviders()
        ])
        if (described.ok !== true) return {}
        if (configurable.ok !== true) return {}
        const out = {}
        for (const entry of configurable.value) {
          const view = described.value.namespaces.find((row) => row.ns === entry.settingsNs)
          if (view === undefined) continue
          const profile = pathValue(view.value, entry.settingsPath === undefined ? [] : entry.settingsPath)
          if (profile === null || typeof profile !== 'object') continue
          const models = Array.isArray(profile.models) ? profile.models : []
          for (const model of models) {
            if (model === null || typeof model !== 'object') continue
            if (typeof model.id !== 'string') continue
            if (typeof model.contextWindow !== 'number') continue
            out[entry.provider + '/' + model.id] = model.contextWindow
          }
        }
        return out
      }

      ctx.slots.inject('plugin-hub.sections', () =>
        ctx.slots.register(
          {
            name: 'plugin-hub.sections',
            // id is what the hub panel's renderSlot `{ only }` addresses.
            id: 'plugin-hub.adviser',
            order: 10,
            label: () => t('tab'),
            locale: NS,
            inject: () => ({ form, listProviders, loadModels, loadDeclared })
          },
          SeniorAdviserCard
        )
      )
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})

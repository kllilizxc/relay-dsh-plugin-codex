import {useSyncExternalStore} from 'react'
import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import {SettingsForm, SettingsFormModel, SettingsValueField, settingsTextField} from '@deepseek-ai/dsh-client-ui-primitives'

export function installRuntimeSettings(ctx: Context): void {
  const namespace = 'relay-codex-host'
  const t = ctx.locale.bind('relay.codex')
  const form = new SettingsFormModel(ctx.configForms.get(namespace), [settingsTextField('codexCommand')])
  const store = form.bind(() => ({...form.shell(), command: form.field('codexCommand')}))
  const actions = form.actions()
  ctx.effect(() => () => form.dispose(), 'relay-codex: native settings form')
  ctx.effect(() => ctx.configForms.whileServed([namespace], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: namespace, label: () => t('runtimeTitle'), locale: 'relay.codex',
  }, function RuntimeSettings({view}) {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    if (view === 'summary') return t('runtimeDescription')
    return <SettingsForm labels={{unavailable: t('runtimeUnavailable'), readOnly: t('runtimeReadOnly'),
      saveFailed: t('runtimeSaveFailed'), save: t('runtimeSave'), saving: t('runtimeSaving')}}
      state={state} onSave={actions.save} onDiscard={actions.discard}>
      <SettingsValueField id="relay-codex-runtime-command" label={t('runtimePathLabel')}
        hint="auto · bundled · /absolute/path/to/codex" {...state.command}
        overriddenLabel={t('runtimeOverridden')} resetLabel={t('runtimeReset')}
        invalidLabel={t('runtimePathRequired')} disabled={!state.writable}
        onEdit={text => actions.edit('codexCommand', text)} onReset={() => actions.resetField('codexCommand')} />
    </SettingsForm>
  }))), 'relay-codex: native configuration page')
}

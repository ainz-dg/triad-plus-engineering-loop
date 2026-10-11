function writeLine(write, value = '') {
  write(`${value}\n`);
}

function adapterChoice(answer, adapters) {
  const value = answer.trim().toLowerCase();
  if (/^\d+$/.test(value)) return adapters[Number(value) - 1] ?? null;
  return adapters.find((adapter) => adapter.id.toLowerCase() === value) ?? null;
}

async function chooseAdapter(prompt, adapters, write, { installedOnly = false, availableOnly = false, installedIds = [] } = {}) {
  const choices = installedOnly
    ? adapters.filter((adapter) => installedIds.includes(adapter.id))
    : availableOnly
      ? adapters.filter((adapter) => !installedIds.includes(adapter.id))
      : adapters;
  if (choices.length === 0) {
    writeLine(write, installedOnly
      ? 'No installed adapters are available for this operation.'
      : availableOnly
        ? 'All registered adapters are already recorded in this Control Workspace.'
        : 'No adapters are available.');
    return null;
  }
  choices.forEach((adapter, index) => writeLine(write, `${index + 1}) ${adapter.label} (${adapter.id})`));
  while (true) {
    const answer = await prompt.question(`Choose adapter [1-${choices.length}] or enter its ID (blank cancels): `);
    if (!answer.trim()) return null;
    const adapter = adapterChoice(answer, choices);
    if (adapter) return adapter;
    writeLine(write, 'Choose one of the listed adapters.');
  }
}

async function mutateWithConfirmation({ prompt, control, action, adapter, runCommand, write }) {
  const options = { adapterCommand: action, host: adapter.id, control, apply: false };
  try {
    await runCommand(options);
  } catch (error) {
    writeLine(write, `Preflight failed; nothing was changed: ${error.message}`);
    return;
  }
  const answer = await prompt.question('Type apply to execute this exact plan; anything else cancels: ');
  if (answer !== 'apply') {
    writeLine(write, 'Cancelled. No files were changed.');
    return;
  }
  try {
    await runCommand({ ...options, apply: true });
  } catch (error) {
    writeLine(write, `Operation failed safely: ${error.message}`);
  }
}

/** Read-only entry to the existing adapter lifecycle; mutations always use CLI preflight first. */
export async function interactiveAdapterManagement({
  prompt,
  control,
  adapters,
  getInstalledAdapterIds,
  runCommand,
  write = (value) => process.stdout.write(value),
}) {
  while (true) {
    try {
      await runCommand({ adapterCommand: 'list', control });
    } catch (error) {
      writeLine(write, `Could not read this Control Workspace safely: ${error.message}`);
      return;
    }
    let installedIds;
    try {
      installedIds = await getInstalledAdapterIds(control);
    } catch (error) {
      writeLine(write, `Could not read adapter membership safely: ${error.message}`);
      return;
    }
    writeLine(write, '\nManage existing Control Workspace');
    writeLine(write, '1) List installed adapters');
    writeLine(write, '2) Add adapter');
    writeLine(write, '3) Doctor / status');
    writeLine(write, '4) Upgrade adapter');
    writeLine(write, '5) Remove adapter');
    writeLine(write, '6) Exit');
    const action = (await prompt.question('Choose [1-6]: ')).trim().toLowerCase();

    if (action === '1') {
      continue;
    } else if (action === '2') {
      const adapter = await chooseAdapter(prompt, adapters, write, { availableOnly: true, installedIds });
      if (adapter) await mutateWithConfirmation({ prompt, control, action: 'add', adapter, runCommand, write });
    } else if (action === '3') {
      try { await runCommand({ adapterCommand: 'doctor', control }); }
      catch (error) { writeLine(write, `Doctor could not complete safely: ${error.message}`); }
    } else if (action === '4' || action === '5') {
      const adapter = await chooseAdapter(prompt, adapters, write, { installedOnly: true, installedIds });
      if (adapter) {
        await mutateWithConfirmation({
          prompt,
          control,
          action: action === '4' ? 'upgrade' : 'remove',
          adapter,
          runCommand,
          write,
        });
      }
    } else if (action === '6' || !action) {
      writeLine(write, 'Leaving the Control Workspace unchanged unless an operation was explicitly applied.');
      return;
    } else {
      writeLine(write, 'Choose one of the listed actions.');
    }
  }
}

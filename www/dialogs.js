/* Shared dashboard dialogs. All content is inserted as text, never HTML. */
(() => {
  const dialog = document.createElement('dialog');
  dialog.className = 'app-dialog';
  dialog.setAttribute('aria-labelledby', 'app-dialog-title');
  dialog.setAttribute('aria-describedby', 'app-dialog-description');
  dialog.innerHTML = `<form method="dialog"><h2 id="app-dialog-title"></h2><p id="app-dialog-description"></p><label class="dialog-field"><span></span><input autocomplete="off"></label><div class="dialog-actions"><button type="button" class="dialog-cancel">Cancel</button><button type="submit" class="dialog-submit">Continue</button></div></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const title = dialog.querySelector('h2');
  const description = dialog.querySelector('p');
  const field = dialog.querySelector('label');
  const input = dialog.querySelector('input');
  const cancel = dialog.querySelector('.dialog-cancel');
  const submit = dialog.querySelector('.dialog-submit');
  let queue = Promise.resolve();
  function open(kind, message, value = '') {
    const task = () => new Promise(resolve => {
      const previous = document.activeElement;
      title.textContent = kind === 'prompt' ? message : kind === 'confirm' ? 'Confirm action' : 'Something needs attention';
      description.textContent = kind === 'prompt' ? 'Update the value below, then save your change.' : message;
      field.hidden = kind !== 'prompt';
      field.querySelector('span').textContent = message;
      input.value = value;
      input.required = kind === 'prompt';
      input.disabled = kind !== 'prompt';
      cancel.hidden = kind === 'alert';
      submit.textContent = kind === 'prompt' ? 'Save' : kind === 'confirm' ? 'Confirm' : 'Got it';
      submit.classList.toggle('is-destructive', kind === 'confirm');
      let result = kind === 'confirm' ? false : null;
      form.onsubmit = event => {
        event.preventDefault();
        if (kind === 'prompt' && !input.value.trim()) { input.focus(); return; }
        result = kind === 'prompt' ? input.value.trim() : true;
        dialog.close();
      };
      cancel.onclick = () => dialog.close();
      dialog.onclose = () => {
        if (previous?.isConnected) previous.focus();
        else document.querySelector('#homeRefresh')?.focus();
        resolve(result);
      };
      dialog.showModal();
      (kind === 'prompt' ? input : kind === 'confirm' ? cancel : submit).focus();
      if (kind === 'prompt') input.select();
    });
    const pending = queue.then(task);
    queue = pending.catch(() => {});
    return pending;
  }
  window.DashboardUI = {
    prompt: (message, value) => open('prompt', message, value),
    confirm: message => open('confirm', message),
    alert: message => open('alert', message),
  };
})();

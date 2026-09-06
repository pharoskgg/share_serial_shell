export interface RevealViewHost {
  showResolvedView(): boolean;
  commands(): Promise<readonly string[]>;
  execute(command: string): Promise<unknown>;
}

/** Reuse the actual view; the generated focus command can be absent during an extension update. */
export async function revealSerialView(host: RevealViewHost): Promise<void> {
  if (host.showResolvedView()) { return; }
  const commands = await host.commands();
  const focus = 'sharedTerminal.serial.focus';
  const container = 'workbench.view.extension.sharedTerminal';
  if (commands.includes(focus)) {
    try { await host.execute(focus); return; }
    catch (error) {
      // Registration may change between getCommands and executeCommand.
      if (!String(error).includes('not found')) { throw error; }
    }
  }
  if (commands.includes(container)) { await host.execute(container); return; }
  throw new SerialViewUnavailableError();
}

export class SerialViewUnavailableError extends Error {
  constructor() { super('串口面板尚未完成注册，请点击“重新加载窗口”以加载更新后的界面。'); }
}

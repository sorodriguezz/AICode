// The system's open and save dialogs, with the paths they return in the window's form (`uiPath`:
// `C:/Users/me/a.txt` on Windows). Use these instead of @tauri-apps/plugin-dialog's own.
import { open as pluginOpen, save as pluginSave, type OpenDialogOptions, type SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import { uiPath } from "./ui";

type Picked<T extends OpenDialogOptions> = Awaited<ReturnType<typeof pluginOpen<T>>>;

export async function open<T extends OpenDialogOptions>(options?: T): Promise<Picked<T>> {
  const picked = await pluginOpen(options);
  return (Array.isArray(picked) ? picked.map((p) => uiPath(p)) : uiPath(picked as string | null)) as Picked<T>;
}

export async function save(options?: SaveDialogOptions): Promise<string | null> {
  return uiPath(await pluginSave(options));
}

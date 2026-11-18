<img src="src-tauri/icons/128x128.png" width="72" height="72" alt="">

# AICode

**Un editor de escritorio modular para código, notas y trabajo asistido por IA.**

Abre un archivo y empieza a escribir. Cuando un proyecto requiera más herramientas, activa el explorador, la terminal, Git o el chat con IA. AICode funciona en macOS, Windows y Linux, y te deja elegir qué herramientas tienes a mano en cada espacio de trabajo.

[Descargar AICode](https://github.com/sorodriguezz/AICode/releases/latest) · [Read in English](README.md)

## Qué incluye

- **Un editor listo para trabajar.** Monaco, el editor que usa VS Code, ofrece pestañas, varios cursores, búsqueda y reemplazo, y compatibilidad con distintos lenguajes. La paleta de comandos y los atajos personalizables te dan acceso rápido a las acciones que más usas.
- **Herramientas para todo el proyecto.** Explora archivos, busca en toda una carpeta y ejecuta comandos en una terminal integrada con pestañas y paneles divididos. Los mods de Git incluidos te permiten preparar cambios, revisar diffs y consultar el historial de commits. Previsualiza Markdown mientras escribes y abre imágenes en el propio editor.
- **IA a tu manera.** Agrega agentes como Claude, Codex, Gemini u Ollama al chat. Activa de forma independiente el autocompletado local de código o las sugerencias de mensajes de commit. El motor integrado ejecuta modelos en tu equipo una vez descargados. También puedes conectarte a Ollama o a un servidor compatible con OpenAI.
- **Un espacio para cada forma de trabajar.** Arrastra las vistas a la izquierda, a la derecha o abajo. Usa un perfil para cada proyecto con sus propios mods, ajustes, atajos y sesión guardada. Puedes personalizar el tema, los iconos de archivos y la apariencia de la ventana.

Puedes editar sin conexión y sin crear una cuenta de AICode. La aplicación usa Tauri y la vista web de tu sistema operativo.

## Primeros pasos

1. [Descarga el instalador para tu plataforma](https://github.com/sorodriguezz/AICode/releases/latest). Elige un `.dmg` para macOS, un `-setup.exe` para Windows o un AppImage, `.deb` o `.rpm` para Linux.
2. Abre un archivo para escribir o una carpeta para trabajar en un proyecto.
3. Abre **Mods** desde el menú del engranaje. Prueba **Explorer**, **Search** y **Terminal** para armar tu espacio de trabajo. Activa **Source Control (Git)** y **Git Graph** para trabajar con tu repositorio. AICode activa sus dependencias automáticamente.

Para actualizar una instalación existente, usa **Settings → Updates → Check for Updates**.

### El comando `aicode`

La primera vez que se abre, AICode instala `aicode` en el PATH de tu terminal, como `code` en VS Code. Usa una carpeta que no pida contraseña, como `/opt/homebrew/bin` o `~/.local/bin`. En Windows agrega `AICode\bin` al PATH de tu usuario, así que abre una terminal nueva después de instalarlo. Si solo queda `/usr/local/bin`, AICode pregunta una vez. Los paquetes `.deb` y `.rpm` ya instalan `/usr/bin/aicode`. Puedes instalarlo o quitarlo cuando quieras con **Shell Command: Install 'aicode' Command in PATH** y **Shell Command: Uninstall 'aicode' Command from PATH**.

```sh
aicode .                    # abre esta carpeta (en la ventana que ya la tiene, si existe)
aicode notas.md             # abre un archivo; si no existe, se crea vacío
aicode -g src/app.ts:12:5   # abre en la línea 12, columna 5
aicode -d viejo.txt nuevo.txt   # compara dos archivos
aicode -n . / aicode -r .   # ventana nueva / la ventana del frente
git config --global core.editor "aicode -w"   # -w espera a que cierres el archivo
echo hola | aicode -        # abre lo que llega por stdin
```

`aicode --help` muestra todas las opciones. Si AICode no está abierto, `aicode` lo inicia.

En **Source Control**, fetch, pull y push muestran **Cancel Operation** mientras se ejecutan. Si una operación de red supera 120 segundos, se detiene y muestra un error; puedes ajustar ese plazo en **Settings → Source Control (Git) → remoteTimeout**. Los detalles quedan en **Git: Show Git Output**.

En **Terminal**, arrastra imágenes, documentos o carpetas desde Finder o el explorador de archivos del sistema sobre una división para pegar sus rutas en la entrada actual, también cuando usas Claude u otro agente. Puedes soltar varios archivos; la entrada queda lista para revisar antes de enviarla. Arrastra el separador entre terminales para cambiar sus tamaños y haz doble clic para igualarlos. Un borde tenue identifica la división activa.

En macOS, **Option (⌥)** permite escribir `@`, `|`, llaves, corchetes y acentos con la misma distribución de teclado que el editor. **Option + ←/→** sigue moviendo el cursor por palabras.

La flecha junto al botón de dividir permite crear un panel a la derecha, izquierda, arriba o abajo del activo. **New Terminal Below Entire Group** agrega uno que ocupa todo el ancho debajo del grupo. Para obtener tres arriba y uno ancho abajo, abre cuatro terminales y elige **Arrange Panes… → 3 Above + 1 Wide Below** en ese mismo menú. También hay filas, columnas y una cuadrícula. Puedes arrastrar una entrada de la lista de terminales sobre el borde de un panel para moverla allí; el borde exterior del grupo permite colocarla por encima o debajo de todo el conjunto. La previsualización indica el destino y **Esc** cancela. El menú contextual **Move Pane…** ofrece los mismos movimientos sin arrastrar. Reorganizar conserva los procesos y su contenido.

Activa **Terminal AI** para agregar el botón del robot y **Terminal AI: Open Agent…**, que abren los CLI de los agentes habilitados, como Claude, Codex, Gemini y OpenCode. **Open Agent in Split…** los abre junto a la terminal actual. **Add Agent Profile…** permite agregar otros ejecutables; sus argumentos se configuran en `Terminal AI → agentProfiles`. Los perfiles existentes se conservan al actualizar. Terminal AI funciona sin activar AI Chat.

Desde el menú contextual del editor, **Send Selection to Agent Terminal…** y **Send File to Agent Terminal…** permiten elegir la sesión que recibirá el contexto, incluidos los cambios sin guardar. El texto se pega para revisarlo antes de enviarlo. Si activas **MCP Server**, Terminal AI pasa automáticamente su configuración a los CLI de Claude y Codex. La etiqueta **MCP** indica que se entregó la configuración; puedes confirmar la conexión desde el propio CLI.

## Hazlo tuyo

Los mods pueden agregar comandos, fragmentos de código, temas y paneles. Con un solo archivo JSON puedes crear un panel para lanzar los comandos de tu proyecto. Usa JavaScript si necesitas una vista personalizada o una integración más profunda con el editor. Exporta un mod como archivo `.aicode-mod` o comparte un perfil, con sus mods incluidos, como archivo `.aicode-profile`.

Para trabajar con agentes, el **MCP Server** opcional permite a clientes compatibles leer el contenido de los archivos abiertos, incluidos cambios sin guardar, y proponerte ediciones que puedes revisar como un diff. El mod **CodeFlow** puede ejecutar flujos con el archivo actual o una selección como entrada. Activa MCP si también quieres que los agentes de CodeFlow se conecten a AICode.

- [Crea un mod con JSON](docs/MOD-GUIDE.md)
- [Explora la API de mods en JavaScript y sus permisos](docs/MODS.md)
- [Personaliza los ajustes, temas y paneles](docs/CONFIGURATION.md)
- [Compila AICode desde el código fuente](docs/DEVELOPMENT.md)

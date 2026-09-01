# Daemon de servicios de la caja

Vigila los dos microservicios de los que depende el punto de venta y los levanta
cuando se caen, sin que nadie tenga que entrar a la caja.

| Servicio | Qué es | Puerto (de fábrica) | Cómo arranca |
|---|---|---|---|
| Impresión | `nestor_printer.exe`, servicio de Windows bajo NSSM (`NestorPrinter`) | 8331 | El SCM, al iniciar el equipo |
| Terminal EMV | `NestorSantanderEmvService.exe`, app de bandeja | 5000 | Tarea programada `NestorSantanderEMV` (ONLOGON, elevada) |

Antes de esto, cuando cualquiera de los dos se caía había que ir a la caja: `sc start
NestorPrinter` para la impresión, y un `.ps1` a mano para el EMV. Mientras tanto el
cajero sólo veía "no imprime" o "no pasa la tarjeta", que es indistinguible de un cable
suelto — así que la llamada a soporte era inevitable.

Vive en [`src/services.watchdog.js`](../src/services.watchdog.js). La arquitectura es
deliberadamente la misma de `ensureLocalServer` en `main.js`: sondeo barato, una sola
reparación serializada, reintentos con espera, y estado que se difunde al renderer sólo
cuando cambia.

## Qué hace, exactamente

Cada 15 segundos sondea los dos puertos. Tras **3 fallos seguidos** ejecuta la escalera
de rescate del servicio, con espera creciente entre intentos (10 s, 30 s, 2 min, 5 min)
y un tope de **5 rescates por hora**; pasado el tope se declara `rendido` y sube una
incidencia.

### Estados

Vocabulario cerrado, porque lo pinta el frontend (`services/client.services.js` →
`stateLabel`):

| Estado | Significa | Qué hace el daemon |
|---|---|---|
| `desconocido` | Todavía no se sondea | — |
| `ok` | Contesta (puede traer `warn`) | Nada |
| `sospechoso` | Falló, sin llegar a los 3 fallos | Espera |
| `rescatando` | Actuando, o esperando entre intentos | Rescate |
| `caido` | Confirmado abajo, no se va a actuar | Reporta (modo observación) |
| `rendido` | Se intentó y no se sostiene | Reporta y se detiene |

`warn` es aparte del estado: el servicio contesta pero algo va mal. Los dos casos
reales son la DLL del printer sin cargar y la terminal EMV no lista. **Ninguno dispara
rescate** — reiniciar no devuelve una DLL en cuarentena ni conecta un PIN pad.

## Las cuatro decisiones que no son obvias

**1. Se sondea el puerto, no el proceso.** `sc query` diciendo RUNNING no significa que
el servicio conteste. El caso "arriba pero colgado" es real y es el único que **nada
más en el sistema puede detectar**: ni el SCM, ni NSSM, ni el updater. Es la mitad de
la razón de existir del daemon.

**2. El 503 del EMV no es una caída.** `/api/health` contesta 503 **con cuerpo** cuando
el servicio está vivo pero la terminal no está lista. Reiniciar el proceso por un PIN
pad desconectado no arregla nada y sí tira la sesión con el host. Sólo "no contesta"
dispara rescate.

**3. Nunca se rescata con trabajo en vuelo.** Lanzar el EMV mata la instancia previa
(`Program.cs` → `KillPreviousInstances`), así que un rescate a media lectura de tarjeta
**mata el cobro**. Dos compuertas:

- **Automática**: el proceso principal observa las peticiones de la ventana hacia :8331
  y :5000 (`webRequest`). Si hubo tráfico hace menos de 90 s, la ronda se salta.
  Los **latidos no cuentan** — el indicador de la barra sondea `/api/health` cada 3 s, y
  si eso contara como uso la compuerta jamás se abriría y el rescate quedaría muerto sin
  un solo error en la bitácora. Lo cubre `scripts/check-services-watchdog.js`.
- **Explícita**: el POS toma un `holdScope` alrededor del cobro con tarjeta, que una
  venta EMV bloquea hasta 75 s en silencio y ese silencio es indistinguible de un
  servicio muerto.

**4. Se rinde.** Con backoff, tope por hora y un estado final que sube incidencia. Sin
eso, una caja con la DLL en cuarentena se convierte en un bucle de reinicios que además
entierra la causa real.

## Escaleras de rescate

**Impresión** — el nombre del servicio se descubre de
`C:\NestorMX\NestorPOS\instance.json` (`printer_service`); una instancia adicional lo
deja vacío porque comparte el de la principal.

1. `sc query` → si no existe, se rinde (hay que reinstalar).
2. Detenido → `sc start`.
3. RUNNING pero sin contestar → `sc stop`, esperar el STOPPED real, `sc start`.
4. Sin permiso → `schtasks /Run /TN NestorPrinterRescue` (tarea elevada como SYSTEM que
   registra el instalador).

**Terminal EMV** — la única vía es la tarea programada: el exe es
`requireAdministrator` y el cliente **no corre elevado**, así que un `CreateProcess`
directo plantaría un UAC en la cara del cajero. Se mata el proceso colgado si lo hay
(para dejarlo dicho en la bitácora, no porque haga falta) y se dispara
`schtasks /Run /TN NestorSantanderEMV`. Después se espera **hasta 60 s** a que
conteste: el arranque hace login contra el host de Santander y detecta el puerto COM.

## Encendido desde el POS

El servicio de impresión se vigila desde que arranca el cliente. **La terminal EMV no**,
hasta que el POS diga que esta caja la tiene — así una caja sin terminal nunca intenta
lanzar un microservicio que no le toca.

`pos.view.vue` lo enciende con `clientServices.ensure(EMV)` en el mismo punto donde
adopta `is_santander_emv_available` del paquete, y lo sigue con un `watch` por si cambia
en un resync. Ese `ensure` **no sólo vigila: si el microservicio no está, lo lanza** —
es lo que sustituye al `.ps1`.

## Lo que ve el cajero

- **Terminal EMV**: el indicador de siempre, con dos estados nuevos —
  "RESTABLECIENDO…" en ámbar mientras el cliente lo levanta, y "REQUIERE ATENCIÓN"
  cuando se rindió. El ámbar importa: en rojo, la reacción correcta (esperar) se ve
  como la incorrecta (llamar a soporte).
- **Impresión**: indicador nuevo, callado mientras todo va bien. Clic = reparar ahora.
- **Modal F11**: botón "Reiniciar servicio EMV" y una nota con lo que el cliente ya
  intentó por su cuenta — sin ella, alguien que abre el modal a media reparación
  reinicia encima y mata el proceso que está arrancando.

Una reparación pedida a mano se salta la espera entre intentos y el tope por hora
(el momento lo elige una persona que está viendo la caja), pero **no** la compuerta de
trabajo en vuelo. Eso nunca.

## Diagnóstico

**Bitácora local** — `C:\ProgramData\NestorPOS\servicios\servicios.log`, rotada a 2 MB.
Cada sondeo fallido, cada intento y cada resultado. Se escribe también en modo
observación.

**Bitácora del servicio de impresión** — `C:\NestorMX\NestorPOS\logs\printer.log`,
rotado por día y a 10 MB. **Esto es nuevo**: hasta ahora NSSM se registraba sin
redirección de salida, así que todo lo que el servicio imprimía —incluido el
`FATAL: nestor_printer.dll no disponible`— se iba a la nada. Sin ese log, el rescate
automático sólo tapa el síntoma.

**En la nube** — al rendirse se sube una incidencia por el canal de errores POS
(`E_SERVICIO_CAIDO_PRINTER` / `_EMV`), indexada por licencia y caja, con el estado de
salud, los pasos intentados y cuántos rescates lleva en la hora. Una sola por episodio.

**Por qué no rescató** — `status()` expone `lastTrafficAt` y `holdUntil` justamente para
eso: casi siempre la respuesta es que no se toca un servicio que se está usando.

## Cómo se configura

Desde la ventana de **Configuración del cliente → Servicios de la caja → «Configurar
servicios…»**, que abre un asistente de cinco pasos
([`src/pages/services.wizard.html`](../src/pages/services.wizard.html)). Lo que se
guarda vive en `config.json` **junto a la bitácora**, no en el userData: por lo mismo
que la bitácora, tiene que sobrevivir al botón rojo de «Eliminar datos y caché». Que
borrar el caché te devuelva una caja apuntando al servicio equivocado sería una trampa.

El esquema —de aquí salen los valores de fábrica, el saneado y los campos del
asistente— vive en [`src/services.config.js`](../src/services.config.js).

Antes de esto el daemon **sólo** se sintonizaba con variables de entorno, y el cliente
no lee ningún `.env`: en la práctica una caja corría con los valores de fábrica y
cambiar cualquier cosa —el nombre del servicio de impresión, poner una caja en
observación— pedía entrar por escritorio remoto a tocar el entorno del usuario y
reiniciar.

### Precedencia: entorno > archivo > fábrica

El entorno **gana siempre**, y esa es la decisión importante: una variable de entorno es
la vía de emergencia (arrancar una caja rota con `NESTOR_SERVICES=0`) y la de
desarrollo, y si el archivo pudiera pisarla dejaría de ser fiable justo cuando se
necesita. A cambio, un campo fijado por entorno se muestra **bloqueado y con el nombre
de la variable que lo fija** — porque el único fallo peor que no poder configurar algo
es configurarlo y que no surta efecto sin que nadie lo diga. Guardar tampoco lo escribe:
esas claves vuelven en `ignoradas` y el asistente las nombra en pantalla.

Todo se aplica **en caliente**: `aplicaConfig()` reescribe los umbrales, reprograma el
intervalo, invalida el nombre de servicio cacheado y borra los fallos acumulados (un
servicio recién reapuntado no debe arrastrar los del anterior). No hace falta reiniciar
el cliente ni la caja.

### Los ajustes

| Clave | Fábrica | Variable que lo fija | Para qué |
|---|---|---|---|
| `enabled` | `true` | `NESTOR_SERVICES` | Apagado, ni sondea |
| `rescue` | `true` | `NESTOR_SERVICES_RESCUE` | Apagado = **modo observación** |
| `printer_watch` | `siempre` | — | `nunca` para una caja que no imprime aquí |
| `printer_service` | *(descubrir)* | `NESTOR_PRINTER_SERVICE` | Nombre del servicio de Windows |
| `printer_instance_file` | *(los dos de siempre)* | — | De qué `instance.json` leerlo |
| `printer_port` | `8331` | `NESTOR_PRINTER_PORT` | Puerto del printer |
| `printer_rescue_task` | `NestorPrinterRescue` | `NESTOR_PRINTER_RESCUE_TASK` | Tarea elevada de respaldo |
| `emv_watch` | `auto` | — | `auto` \| `siempre` \| `nunca` |
| `emv_task` | `NestorSantanderEMV` | `NESTOR_EMV_TASK` | Única vía de rescate del EMV |
| `emv_exe` | `NestorSantanderEmvService.exe` | `NESTOR_EMV_EXE` | Para ver si vive y terminarlo |
| `emv_port` | `5000` | `NESTOR_EMV_PORT` | Puerto del EMV |
| `watch_ms` | `15000` | `NESTOR_SERVICES_WATCH_MS` | Cada cuánto se sondea (mínimo 5 s) |
| `probe_ms` | `2500` | `NESTOR_SERVICES_PROBE_MS` | Paciencia de cada sondeo |
| `strikes` | `3` | `NESTOR_SERVICES_STRIKES` | Fallos seguidos antes de actuar |
| `quiet_ms` | `90000` | `NESTOR_SERVICES_QUIET_MS` | Silencio exigido antes de rescatar |
| `max_per_hour` | `5` | `NESTOR_SERVICES_MAX_HOUR` | Rescates por hora antes de rendirse |
| `settle_printer_ms` | `20000` | `NESTOR_SERVICES_SETTLE_PRINTER_MS` | Espera a que el printer conteste |
| `settle_emv_ms` | `60000` | `NESTOR_SERVICES_SETTLE_EMV_MS` | Espera a que el EMV conteste |

`NESTOR_SERVICES_DIR` sigue siendo sólo de entorno: es dónde vive la bitácora, y por
tanto dónde se busca este mismo archivo.

**`emv_watch: nunca` gana sobre el POS.** El paquete dice si el *negocio* tiene
terminal; esto dice si *esta caja* la tiene enchufada, y eso sólo lo sabe quien está
delante. Sin ese portillo, una caja sin PIN pad en un negocio que sí cobra con tarjeta
intentaría lanzar el microservicio en cada arranque, para siempre.

### El asistente

Cinco pasos: **Estado** (qué se ve ahora mismo, y el interruptor maestro) → **Impresión**
→ **Terminal** → **Comportamiento** → **Resumen** (el diff de lo que va a cambiar).

Las dos cosas que lo hacen útil, y que son la razón de que no sea un formulario plano:

- **Se elige de una lista, no se teclea.** El nombre del servicio sale de `sc query type=
  service state= all` y el de la tarea de `schtasks /Query /FO CSV /NH`, con lo que
  *parece* nuestro (nestor/printer/emv/santander) agrupado arriba: en una máquina con 250
  servicios, una lista alfabética es lo mismo que no tener lista. Se muestra además qué
  dice cada `instance.json`, y el `instance.json` se puede elegir con el diálogo del
  sistema. Teclear de memoria un nombre que además cambia entre instalaciones es la forma
  más fácil de configurar esto mal.
- **Se prueba antes de guardar.** El botón «Probar» sondea el puerto candidato y consulta
  el SCM y las tareas, y contesta con un renglón por comprobación. Sin eso habría que
  guardar, esperar la siguiente ronda y deducir el resultado del color de una pastilla.

### Nunca se toca un servicio ajeno

**El incidente del Spooler.** El Spooler de Windows se llama «Cola de impresión», y el
filtro que destacaba «lo que parece nuestro» miraba también el nombre visible: el
Spooler subía al grupo de arriba del desplegable, junto a los nuestros. Elegirlo era lo
natural —dice impresión— y a partir de ahí, cada vez que `nestor_printer` no contestaba
en `:8331`, el rescate veía el Spooler en RUNNING y le hacía `sc stop` + `sc start`.
Hasta cinco veces por hora; cuando el arranque no prendía, la máquina se quedaba sin
imprimir **nada**, y el síntoma no se parecía en nada a su causa.

Tres barreras, y las tres se comprueban en `check-services-watchdog.js`:

1. **No se destaca.** `pareceServicioNuestro()` mira el **nombre**, nunca el nombre
   visible. Destacar de más aquí no es una molestia: es una trampa.
2. **No se guarda.** `SERVICIOS_PROTEGIDOS` en `services.config.js` (Spooler, RPC, WMI,
   Programador de tareas, Escritorio remoto…) se rechaza al guardar **y** al leer el
   archivo — uno editado a mano, o escrito por una versión anterior, choca contra el
   mismo muro y el daemon lo dice en la bitácora. En la lista se ven, bloqueados y con
   el motivo: esconderlos haría que quien busca «Cola de impresión» pensara que la lista
   está incompleta y lo escribiera a mano.
3. **No se reinicia.** `puedeReiniciarServicio()` corre **antes de cualquier `sc stop`**:
   si el nombre no empieza por `Nestor`, se consulta el ejecutable con `sc qc` y sólo se
   sigue si la ruta es nuestra. Si no se puede comprobar, no se toca. Un `sc stop` sobre
   un servicio ajeno no se puede deshacer.

Lo que el asistente **no** hace es registrar el servicio ni la tarea: eso es cosa del
instalador y pide elevación, y el cliente no corre elevado (ver *Dos landmines de
despliegue*). Cuando faltan, lo dice con esas palabras en vez de intentarlo.

En macOS y Linux el daemon corre siempre en observación —no hay servicios ni tareas de
Windows que rescatar— y las listas salen vacías con esa explicación, en vez de parecer
un error.

**Conviene estrenar una caja en observación** (paso 1 → «Sólo observar y reportar»).
Desplegar rescate automático a una flota con un error adentro es una caída de flota, y el
modo observación ya entrega lo más valioso: saber qué cajas están fallando y por qué.

## Lo que prepara el instalador

En `NestorPOS_Setup.iss`, al registrar el servicio de impresión:

- `HardenPrinterService` — NSSM reinicia el proceso al terminar (`AppExit Restart`,
  `AppThrottle 5000`), el SCM reinicia el servicio si muere el propio NSSM
  (`sc failure` + `failureflag`), y la salida va a `logs\printer.log` con rotación.
- `GrantServiceControlToInteractiveUsers` — añade un ACE a la DACL del servicio para que
  el usuario de la caja pueda consultarlo, pararlo y arrancarlo. Es lo que permite que
  el cliente, sin elevar, haga `sc start`. Lee el SDDL vigente con `sc sdshow` y le
  agrega el ACE; **no** lo escribe desde cero, que dejaría al SCM sin sus permisos.
- `RegisterPrinterRescueTask` — la tarea de respaldo `NestorPrinterRescue`, como SYSTEM,
  con el SDDL que permite dispararla a usuarios autenticados.

Y en el componente EMV, el mismo SDDL sobre `NestorSantanderEMV` para que el cliente
pueda invocarla.

## Dos landmines de despliegue

**La tarea del EMV se registra bajo la cuenta que instaló** (`schtasks /Create` sin
`/RU`). Si la caja inicia sesión con otro usuario, ni el disparador ONLOGON se dispara
para él ni el ícono de bandeja aparecerá en su sesión. **Instala con la cuenta con la
que se trabaja en la caja.**

**Las instalaciones existentes no tienen los permisos.** El ACE del servicio y los SDDL
de las tareas los concede el instalador, así que una caja que no se reinstale caerá en
"sin permiso" y el daemon lo dirá con esas palabras: *"este usuario no puede controlar
el servicio y no existe la tarea de respaldo; hay que reinstalar"*. No intenta pedir
UAC por su cuenta.

## Al tocar esto

- Canal IPC nuevo → agrégalo a `capabilities` **y** sube `version` en `preload.js`. El
  frontend lo sirve el backend y el cliente se actualiza por su cuenta, así que un
  frontend nuevo sobre un cliente viejo es lo normal — y un canal inexistente hace que
  `invoke` **rechace**, no que devuelva un error manejable.
- Ajuste nuevo → un renglón en `ESQUEMA` (`services.config.js`) **y** su control en
  `services.wizard.html` con `data-clave="<clave>"`. `check-services-wizard.js` falla si
  falta cualquiera de los dos; sin él, el campo queda imposible de configurar y la página
  se dibuja igual de bien.
- Contenido nuevo en el asistente o en la página de Configuración → va dentro de
  `<main>` / `.contenido`, que es donde vive el scroll. El documento **no** se desplaza
  (`body { overflow:hidden }`): si algo se cuelga fuera de esa área, en una caja táctil
  sin rueda queda inalcanzable, y las barras van estilizadas justamente para que se
  vean siempre — en Windows 11 una barra oculta hace que "no se puede bajar" y "no hay
  nada más abajo" se vean igual.
- Radio nuevo → con `name`. Sin él el grupo no se excluye, quedan dos marcados a la vez y
  se guarda la opción que el operador **no** eligió. Es invisible a ojo y silencioso en
  ejecución; el check lo comprueba.
- Estado nuevo en el vocabulario → agrégalo a `stateLabel` en
  `services/client.services.js` y a la lista de `check-services-watchdog.js`, o saldrá
  como texto vacío en la barra.
- Ruta de trabajo nueva en el printer o el EMV → no hay que hacer nada: la compuerta de
  tráfico excluye latidos por lista, todo lo demás cuenta solo. Un endpoint de **salud**
  nuevo sí hay que excluirlo en `esLatido()`.
- `npm run check` cubre la clasificación de rutas, el vocabulario y la vigilancia
  inicial.

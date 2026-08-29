# Daemon de servicios de la caja

Vigila los dos microservicios de los que depende el punto de venta y los levanta
cuando se caen, sin que nadie tenga que entrar a la caja.

| Servicio | Qué es | Puerto | Cómo arranca |
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

## Interruptores

| Variable | Por omisión | Para qué |
|---|---|---|
| `NESTOR_SERVICES` | `1` | `0` apaga el daemon entero |
| `NESTOR_SERVICES_RESCUE` | `1` | `0` = **modo observación**: sondea, registra y reporta, sin tocar nada |
| `NESTOR_SERVICES_WATCH_MS` | `15000` | Cada cuánto se sondea (mínimo 5 s) |
| `NESTOR_SERVICES_STRIKES` | `3` | Fallos seguidos antes de actuar |
| `NESTOR_SERVICES_QUIET_MS` | `90000` | Silencio exigido antes de rescatar |
| `NESTOR_SERVICES_MAX_HOUR` | `5` | Rescates por hora antes de rendirse |
| `NESTOR_PRINTER_SERVICE` | de `instance.json` | Override del nombre del servicio |
| `NESTOR_EMV_TASK` | `NestorSantanderEMV` | Override del nombre de la tarea |
| `NESTOR_SERVICES_SETTLE_EMV_MS` | `60000` | Cuánto se espera a que el EMV conteste |

En macOS y Linux el daemon corre siempre en observación: no hay servicios ni tareas de
Windows que rescatar.

**Conviene pilotear con `NESTOR_SERVICES_RESCUE=0`.** Desplegar rescate automático a una
flota con un error adentro es una caída de flota, y el modo observación ya entrega lo
más valioso: saber qué cajas están fallando y por qué.

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
- Estado nuevo en el vocabulario → agrégalo a `stateLabel` en
  `services/client.services.js` y a la lista de `check-services-watchdog.js`, o saldrá
  como texto vacío en la barra.
- Ruta de trabajo nueva en el printer o el EMV → no hay que hacer nada: la compuerta de
  tráfico excluye latidos por lista, todo lo demás cuenta solo. Un endpoint de **salud**
  nuevo sí hay que excluirlo en `esLatido()`.
- `npm run check` cubre la clasificación de rutas, el vocabulario y la vigilancia
  inicial.

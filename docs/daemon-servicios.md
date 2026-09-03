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

Cada 3 segundos sondea los dos puertos. Tras **3 fallos seguidos** ejecuta la escalera
de rescate del servicio, con espera creciente entre intentos (10 s, 30 s, 2 min, 5 min)
y un tope de **5 rescates por hora**; pasado el tope se declara `rendido` y sube una
incidencia.

Son dos consultas HTTP a localhost que no tocan la impresora ni la terminal —el
indicador del POS ya pregunta al EMV a este mismo ritmo—, así que una caída silenciosa
se confirma en unos **6 segundos**. Cuando es la ventana la que se estrella contra el
servicio, antes: ver *La ventana también avisa*.

### La ventana también avisa

El daemon no es el único que sabe si el servicio contesta: la ventana se estrella contra
él en cuanto el cajero pulsa «imprimir». `onErrorOccurred` recoge ese fallo, y si es de
**conexión** (`ERR_CONNECTION_REFUSED` y compañía, nunca un `ERR_ABORTED`, que es la
ventana cancelando) cuenta como confirmación: se da la caída por buena sin esperar los
sondeos que falten, y se comprueba en el acto en vez de esperar a la siguiente ronda.

Medido contra un servicio de mentira que se tira a propósito:

| Situación | Se detecta en |
|---|---|
| Se cae y nadie lo está usando | ~6 s (3 sondeos) |
| El cajero pulsa imprimir y falla | ~0,1 s |
| El cajero reintenta cada 2 s | ~2 s (antes: **nunca**) |

Después viene el rescate en sí, y ahí manda lo que tarde el servicio en arrancar:
`settle_printer_ms` (20 s) y `settle_emv_ms` (60 s) son el tope de espera, pero en
cuanto contesta se sale — se comprueba cada segundo.

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
**mata el cobro**. Tres compuertas, y la primera es la que de verdad protege:

- **Petición en curso**: mientras una petición de la ventana hacia el servicio no haya
  terminado, no se toca — dure lo que dure, y una venta EMV bloquea hasta 75 s. Se lleva
  por id de petición y no como un contador, porque un contador que no vuelve a cero (la
  ventana se recarga a media impresión) blindaría el servicio para siempre.
- **Silencio tras un uso que salió BIEN**: 20 s. Cubre el hueco entre dos operaciones
  seguidas, no la operación en sí.
- **Explícita**: el POS toma un `holdScope` alrededor del cobro con tarjeta.

Los **latidos no cuentan** ni como uso ni como trabajo en vuelo — el indicador de la
barra sondea `/api/health` cada 3 s, y si eso contara la compuerta jamás se abriría y el
rescate quedaría muerto sin un solo error en la bitácora. Lo cubre
`scripts/check-services-watchdog.js`.

**Lo que terminó BIEN, no lo que salió.** Aquí hubo un fallo que hacía que el rescate
llegara tardísimo o nunca: el uso se anotaba en `onBeforeRequest`, o sea al SALIR la
petición, sin mirar cómo terminaba. Con el servicio caído, cada intento de imprimir del
cajero contaba como "se está usando" y empujaba la espera otros 90 s — de modo que
**cuanto más intentaba imprimir, más se retrasaba el arreglo**, y con reintentos
seguidos no llegaba nunca. Una petición que se estrella contra un puerto cerrado no es
uso: es la prueba de la caída.

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

**Terminal EMV** — no es un servicio de Windows: es un ejecutable con ícono de
bandeja.

0. **Se decide antes de tocar nada.** Se lee la definición de la tarea y su último
   resultado, y se comprueba que el ejecutable esté. Si no hay ninguna vía, se dice con
   el motivo concreto y se declara `fatal` — **sin matar el proceso**. Antes se mataba
   primero y se descubría después que no había con qué relanzarlo: cada intento dejaba
   la caja sin terminal *y* sin el ícono de bandeja con el que el cajero podía
   arrancarla a mano.
1. Si el proceso vive pero el puerto no contesta (colgado), `taskkill /F` y **3 s** de
   margen para que el Programador reapareje la instancia.
2. `schtasks /Run /TN NestorSantanderEMV` — **y después se comprueba que el proceso
   aparezca** (hasta 10 s). Ver abajo por qué esto es la mitad del arreglo.
3. Arranque directo del ejecutable (`emv_direct_launch`, encendido de fábrica). Falla
   con `ERROR_ELEVATION_REQUIRED` si el exe pide administrador y la caja no lo es —
   Windows no abre un UAC desde `CreateProcess`, devuelve el error. Eso se dice con
   esas palabras en vez de dejar la caja en «Restableciendo…».

### Por qué `schtasks /Run` devolviendo 0 no significa nada

Es la causa del atasco que se veía en las cajas: la terminal se quedaba en
«Restableciendo…» indefinidamente. `schtasks /Run` devuelve 0 en cuanto el Programador
**acepta** la petición — no espera al proceso, no comprueba que arrancara y no dice por
qué no. El daemon lo tomaba como éxito, se iba a esperar 60 s al puerto 5000, no pasaba
nada, y volvía a intentarlo.

Las cuatro formas de que devuelva 0 sin arrancar nada:

| Causa | Cómo se ve | Qué la arregla |
|---|---|---|
| `MultipleInstancesPolicy = IgnoreNew` | Estado `Queued`/`Running` | Registrarla con `StopExisting` |
| Registrada a nombre de quien instaló (`schtasks /Create` sin `/RU`) | Último resultado `0x41303` | Registrarla a nombre de quien usa la caja |
| La acción apunta a un .exe que ya no está | Último resultado `0x2` | Reinstalar el componente |
| La tarea está deshabilitada | — | Habilitarla |

Sólo las dos últimas bloquean. Las otras se intentan igual, porque a veces arrancan y la
única prueba que vale es si aparece el proceso.

Ninguna se distingue por el código de salida; todas se distinguen leyendo la
**definición** de la tarea (`schtasks /Query /XML`, que no está traducido) y su
**último resultado** (`Get-ScheduledTaskInfo`, que devuelve un número y no texto en
español). Eso es `src/services.tasks.js`, y es lo que convierte «Rescatando» en una
frase que se puede leer en la caja.

El diagnóstico separa **problemas** de **bloqueantes**: `IgnoreNew` es un problema pero
no bloquea —a veces arranca, según si el Programador ya reaparejó la instancia
anterior—, así que se intenta igual y se comprueba el resultado. Una tarea deshabilitada
o apuntando a un .exe que no está no arranca nunca, y probar sólo gasta el rato que la
caja pasa sin cobrar.

> **`0x41303` no siempre significa avería.** Una tarea **recién creada y nunca
> disparada** trae ese mismo último resultado y una fecha centinela
> (`30/11/1999`) — que es el estado normal de la tarea de respaldo, que no tiene
> disparador y existe sólo para que alguien la llame. Al contarlo como problema, el paso
> «Requisitos» instalaba la tarea correctamente y **seguía diciendo que faltaba**: el
> operador volvía a pulsar el botón, aceptaba otro UAC y no cambiaba nada. Se distinguen
> por la fecha (`nuncaEjecutada`).

> **Que el proceso no aparezca a los ocho segundos tampoco es prueba.** Con la tarea
> bien registrada, el Programador todavía tiene que localizar la sesión interactiva del
> usuario, y el antivirus escanea el ejecutable la primera vez tras registrarla; en una
> caja real eso tardó más de diez segundos y acabó arrancando bien. Por eso, cuando la
> tarea **acepta** el disparo, se le entrega la ventana de arranque (`settleUntil`) en
> vez de declarar `fatal`. Declararlo era el mismo error de antes con otra cara — dar
> por bueno lo que no se ha comprobado, sólo que al revés: una caja perfectamente
> rescatable se daba por perdida para siempre y subía una incidencia.

> **Cuidado con comparar el usuario.** El XML trae el `UserId` de una cuenta normal
> como SID crudo (`S-1-5-21-…-1002`), no como `EQUIPO\usuario`. Comparar eso contra un
> nombre da distinto siempre, y declararía bloqueante —o sea, no intentable— una tarea
> perfectamente registrada. Se compara por SID; por nombre sólo cuando el XML trae un
> nombre. Cuando no se puede comparar con certeza **no se acusa**: apagar la vía
> principal de rescate por una sospecha es peor que no comprobar nada.

### La espera de arranque no bloquea

Tras lanzar un servicio se le da margen (`settle_printer_ms` / `settle_emv_ms`) para
que empiece a contestar. Eso era un bucle con `await` dentro de la ronda: bloqueaba el
daemon **entero** hasta un minuto —sin sondear el printer, sin difundir nada y con el
botón de reparar de la barra colgado de la misma promesa—, así que la caja veía
«Restableciendo…» congelado aunque ya se hubiera arreglado.

Ahora es una marca de tiempo (`settleUntil`) y las rondas normales siguen su curso:
cada 3 s se vuelve a sondear, se actualiza el detalle («arrancando con X: 42 s más») y
se difunde.

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
| `printer_rescue_task` | `NestorPrinterRescue` | `NESTOR_PRINTER_RESCUE_TASK` | Tarea elevada de respaldo (último escalón) |
| `emv_watch` | `auto` | — | `auto` \| `siempre` \| `nunca` |
| `emv_task` | `NestorSantanderEMV` | `NESTOR_EMV_TASK` | Única vía de rescate del EMV |
| `emv_exe` | `NestorSantanderEmvService.exe` | `NESTOR_EMV_EXE` | Para ver si vive y terminarlo |
| `emv_port` | `5000` | `NESTOR_EMV_PORT` | Puerto del EMV |
| `watch_ms` | `3000` | `NESTOR_SERVICES_WATCH_MS` | Cada cuánto se sondea (mínimo 1 s) |
| `probe_ms` | `2000` | `NESTOR_SERVICES_PROBE_MS` | Paciencia de cada sondeo |
| `strikes` | `3` | `NESTOR_SERVICES_STRIKES` | Fallos seguidos antes de actuar |
| `quiet_ms` | `20000` | `NESTOR_SERVICES_QUIET_MS` | Silencio tras un uso que salió bien |
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

Seis pasos: **Estado** (qué se ve ahora mismo, y el interruptor maestro) → **Impresión**
→ **Terminal** → **Comportamiento** → **Requisitos** → **Resumen** (el diff de lo que va
a cambiar).

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
  Para una tarea programada ya no dice «registrada» a secas —eso no contesta la pregunta
  que importa, que es si **va a arrancar algo**— sino su usuario, si está elevada y qué
  pasó la última vez que se disparó.
- **El paso «Requisitos» arregla la caja, no la configura.** Los otros cuatro pasos
  apuntan nombres; éste enseña el estado de la máquina y lo instala si falta. Ver
  [Requisitos de la caja](#requisitos-de-la-caja).

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

## Requisitos de la caja

Para que el rescate funcione hacen falta tres cosas registradas en Windows. **Durante
mucho tiempo ninguna de las tres estuvo**: este documento las describía como si el
instalador las dejara, y `NestorPrinterRescue` no aparecía en `NestorPOS_Setup.iss`
por ningún lado. De ahí que el campo «Tarea de respaldo» del asistente no significara
nada, y que el rescate de la terminal aceptara el disparo sin arrancar nunca.

| Requisito | Para qué | Qué pasa sin él |
|---|---|---|
| ACE de control en el servicio de impresión para `IU` | Que el cliente, sin elevar, pueda `sc start` | El primer escalón falla y todo depende de la tarea |
| Tarea `NestorPrinterRescue` (SYSTEM, sin disparador) | Último escalón cuando lo anterior no se puede | No hay tercer escalón: la caja se rinde |
| SDDL `(A;;FRFX;;;AU)` en las dos tareas | Que un cajero **no administrador** pueda dispararlas | `schtasks /Run` → «Acceso denegado» |

Y la tarea del EMV tiene además que estar **a nombre de quien usa la caja** y con
`MultipleInstances = StopExisting`.

### Quién las instala

**El instalador** (`NestorPOS_Setup.iss`), desde ahora:

- `HardenPrinterService` — NSSM reinicia el proceso al terminar (`AppExit Restart`,
  `AppThrottle 5000`), el SCM reinicia el servicio si muere el propio NSSM
  (`sc failure` + `failureflag`), y la salida va a `logsprinter.log` con rotación.
- `GrantServiceControlToInteractiveUsers` — lee el SDDL vigente con `sc sdshow` y le
  **agrega** el ACE; no lo escribe desde cero, que dejaría al SCM sin sus permisos.
- `RegisterPrinterRescueTask` y la tarea del EMV — por la **API COM** del Programador
  (`Schedule.Service`), no con `schtasks`: es la única forma de fijar el descriptor de
  seguridad y `MultipleInstances`. `schtasks` no tiene opción para ninguna de las dos,
  y por eso nunca estuvieron.

**Y el propio cliente**, en Configuración → Servicios de la caja → **paso 5,
«Requisitos»**. Porque arreglarlo sólo en el instalador no sirve de nada: nadie
reinstala una caja que «casi» funciona. El paso enseña qué falta y qué no se puede
arreglar desde ahí (si falta el .exe del EMV, hay que reinstalar el componente), y el
botón abre **un** aviso de UAC, **una** vez, y sólo con una persona delante.

> El daemon **nunca** lo llama solo. Un UAC apareciendo a media venta sería peor que el
> fallo que viene a arreglar, y además no habría nadie para aceptarlo.

El script elevado se escribe en un directorio temporal del **propio usuario**
(`mkdtemp`), no junto a la bitácora: `ProgramData` lo puede escribir cualquier usuario
de la máquina, y dejar ahí un script que va a correr como administrador es regalar una
escalada de privilegios a cambio de nada.

## Un landmine de despliegue que queda

**Instala con la cuenta con la que se trabaja en la caja.** La tarea del EMV se
registra a nombre de quien corre el instalador; si se eleva con otra cuenta de
administrador, queda a nombre de ésa. Ya no es un callejón sin salida —el cliente
detecta el desajuste comparando SIDs y lo ofrece corregir desde el paso 5— pero es una
visita menos si se hace bien a la primera.

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
- Estado nuevo en `state` → es un **vocabulario cerrado que pinta el frontend**
  (`services/client.services.js` → `stateLabel`, y los dos indicadores de la barra). El
  frontend lo sirve el backend y se actualiza por su cuenta, así que un estado nuevo sale
  como texto vacío en las cajas que aún no lo tengan. Si hace falta más matiz, va en
  `detail` o en un campo propio del payload — así se resolvieron `settleUntil` y `fatal`.
- Tocar `schtasks` → **nunca te creas su código de salida**. `/Run` devuelve 0 en cuanto
  el Programador acepta la petición. Comprueba el efecto (que aparezca el proceso, que el
  servicio pase a RUNNING) y, si no aparece, lee el último resultado con
  `Get-ScheduledTaskInfo`.
- Cambiar el SDDL de las tareas → está en **dos** sitios que tienen que coincidir:
  `SDDL_TAREA` en `src/services.tasks.js` y `#define TaskSddl` en
  `NestorPOS_Setup.iss`. `check-services-tasks.js` comprueba que el del cliente siga
  concediendo ejecución a los usuarios autenticados.
- Tocar el script elevado (`scriptElevado()`) → es PowerShell dentro de un template
  literal de JavaScript, y `node --check` lo da por bueno pase lo que pase dentro de las
  comillas. Un error de sintaxis ahí sólo se ve como «la reparación no dejó resultado»,
  después del UAC y con el operador delante. `check-services-tasks.js` le pasa el
  analizador de PowerShell y comprueba que las variables de entorno que lee sean las que
  `installMissing()` escribe.
- Estado nuevo en el vocabulario → agrégalo a `stateLabel` en
  `services/client.services.js` y a la lista de `check-services-watchdog.js`, o saldrá
  como texto vacío en la barra.
- Ruta de trabajo nueva en el printer o el EMV → no hay que hacer nada: la compuerta de
  tráfico excluye latidos por lista, todo lo demás cuenta solo. Un endpoint de **salud**
  nuevo sí hay que excluirlo en `esLatido()`.
- `npm run check` cubre la clasificación de rutas, el vocabulario y la vigilancia
  inicial.

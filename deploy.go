//go:build ignore
// +build ignore

// deploy.go — sube el instalador Windows de NestorPOS_Client al Fact.
//
// Ejecutar con: go run deploy.go [flags]
//
// Lee output/client_build.json (generado por build.go) para saber qué .exe
// subir y con qué versión/canal. Luego:
//   1. Autentica contra /panel/v1/auth/login (env NESTOR_DEPLOY_USER/PASS).
//   2. POST multipart (en chunks de 8 MB con reintento; ver deployChunkDefault)
//      a /panel/v1/installers con platform=nestor-client-windows.
//   3. El Fact auto-publica el instalador y borra el anterior de ese (canal,
//      plataforma). Queda servido en:
//        https://pos-api.tecpyme.mx/downloads/latest/nestor-client-windows.exe?channel=<canal>
//
// Flags:
//   --version=X.Y.Z    Override de versión (default: la de client_build.json).
//   --channel=internal|prod / --prod / --force-channel=...   Override de canal.
//   --platform=...     Override de plataforma (default: nestor-client-windows).
//   --notes=TEXT       Notas literales del release.
//   --notes-file=PATH  Notas desde archivo.
//   --yes              (default true) omitir confirmación interactiva.
//
// Solo usa la librería estándar de Go — NestorPOS_Client no tiene go.mod.
package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	defaultEndpoint   = "https://pos-api.tecpyme.mx"
	clientPlatform    = "nestor-client-windows"
	outputDir         = "output"
	buildMetaFile     = "output/client_build.json"
	installerChunkSz  = deployChunkDefault // ver deployChunkDefault / NESTOR_DEPLOY_CHUNK_MB
)

type buildMeta struct {
	Version  string `json:"version"`
	Channel  string `json:"channel"`
	Platform string `json:"platform"`
	ExeName  string `json:"exe_name"`
	Commit   string `json:"commit"`
	Branch   string `json:"branch"`
	BuiltAt  string `json:"built_at"`
}

// loadDotEnv carga .env / .env.local sin pisar variables ya definidas.
func loadDotEnv() {
	for _, p := range []string{".env", ".env.local"} {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		fmt.Println("=>", p, "cargado")
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			eq := strings.IndexByte(line, '=')
			if eq < 0 {
				continue
			}
			key := strings.TrimSpace(line[:eq])
			val := strings.Trim(strings.TrimSpace(line[eq+1:]), `"'`)
			if key == "" {
				continue
			}
			if _, ok := os.LookupEnv(key); !ok {
				_ = os.Setenv(key, val)
			}
		}
	}
}

func gitOutput(args ...string) string {
	out, err := exec.Command("git", args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func sanitizeChannel(ch string) string {
	if strings.TrimSpace(ch) == "internal" {
		return "internal"
	}
	return "prod"
}

func confirm(prompt string) bool {
	fmt.Printf("%s [y/N]: ", prompt)
	s, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	s = strings.ToLower(strings.TrimSpace(s))
	return s == "y" || s == "yes"
}

func isInteractive() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return (fi.Mode() & os.ModeCharDevice) != 0
}

type loginResp struct {
	Ok   bool `json:"ok"`
	Data struct {
		Token string `json:"token"`
	} `json:"data"`
}

func loginPanel(endpoint, user, pass string) (string, error) {
	body, _ := json.Marshal(map[string]string{"email": user, "password": pass})
	req, _ := http.NewRequest("POST", endpoint+"/panel/v1/auth/login", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("login falló (%d): %s", resp.StatusCode, string(b))
	}
	var lr loginResp
	if err := json.NewDecoder(resp.Body).Decode(&lr); err != nil {
		return "", err
	}
	if lr.Data.Token == "" {
		return "", fmt.Errorf("login: sin token en la respuesta")
	}
	return lr.Data.Token, nil
}

// suggestNextVersion pide al Fact la siguiente versión sugerida (bump de patch).
// Solo se usa como fallback cuando client_build.json no trae versión.
func suggestNextVersion(endpoint, token, platform, channel string) string {
	url := fmt.Sprintf("%s/panel/v1/releases/next-version?platform=%s&channel=%s", endpoint, platform, channel)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return ""
	}
	var body struct {
		NextVersion string `json:"next_version"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	return body.NextVersion
}

type installerResult struct {
	Ok          bool   `json:"ok"`
	ID          uint   `json:"id"`
	BuildNumber int    `json:"build_number"`
	Version     string `json:"version"`
	Channel     string `json:"channel"`
	Platform    string `json:"platform"`
	Checksum    string `json:"checksum_sha256"`
}

type installerMeta struct {
	Version      string
	Channel      string
	Platform     string
	Notes        string
	ReleaseNotes string
}

// uploadInstallerChunked sube el .exe en trozos a /panel/v1/installers. Los
// chunks intermedios responden 202; el último ensambla y devuelve el resultado.
// ─── Subida resistente a redes inestables ─────────────────────────────────
// Antes: chunks de 50 MB sin reintento, y un solo chunk corrupto en el camino
// («tls: bad record MAC», ~1 de cada 8 subidas de 50 MB desde la red de la
// oficina, medido el 4-nov-2026) tumbaba el deploy completo. Ahora: chunks
// chicos + reintento por chunk con espera creciente.
//
// Reenviar es idempotente: el Fact guarda cada chunk como
// <upload_id>_<indice>.chunk y lo SOBRESCRIBE; solo el ultimo chunk ensambla.
// TLS rechaza un chunk corrupto, asi que nunca se guarda danado, y el ZIP
// ensamblado se valida contra su sha256/firma del lado del Fact.

// deployChunkDefault — tamano de chunk por default. Override con
// NESTOR_DEPLOY_CHUNK_MB (1..95; Cloudflare corta en 100 MB por request).
const deployChunkDefault = 8 * 1024 * 1024

// deployChunkAttempts — intentos por chunk (1 + 5 reintentos).
const deployChunkAttempts = 6

// deployChunkTimeout — tope por REQUEST (un chunk), no por subida completa.
const deployChunkTimeout = 10 * time.Minute

func deployChunkSize() int64 {
	if v := strings.TrimSpace(os.Getenv("NESTOR_DEPLOY_CHUNK_MB")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 95 {
			return int64(n) * 1024 * 1024
		}
		fmt.Fprintf(os.Stderr, "[warn] NESTOR_DEPLOY_CHUNK_MB=%q invalido (1..95); se usan %d MB\n", v, deployChunkDefault/(1024*1024))
	}
	return deployChunkDefault
}

// deployHTTPError — el Fact respondio con un status inesperado. Los errores de
// red (sin respuesta) no usan este tipo y siempre se reintentan.
type deployHTTPError struct {
	status int
	msg    string
}

func (e *deployHTTPError) Error() string { return e.msg }

// retryable — 5xx, 408 y 429 pueden ser transitorios; el resto de 4xx (auth,
// campos, 413) no se arregla reenviando lo mismo.
func (e *deployHTTPError) retryable() bool {
	return e.status >= 500 || e.status == 408 || e.status == 429
}

// sendChunkWithRetry corre send() hasta deployChunkAttempts veces.
func sendChunkWithRetry[T any](i, n int, send func() (*T, error)) (*T, error) {
	waits := []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second}
	netErr := false
	for attempt := 1; ; attempt++ {
		res, err := send()
		if err == nil {
			if attempt > 1 {
				fmt.Printf("     chunk %d/%d OK al intento %d\n", i+1, n, attempt)
			}
			return res, nil
		}
		var he *deployHTTPError
		if errors.As(err, &he) {
			if !he.retryable() {
				return nil, err // 4xx: reintentar no lo arregla
			}
		} else {
			netErr = true
		}
		if attempt >= deployChunkAttempts {
			// El ultimo chunk es el que arma y PERSISTE la publicacion. Si un
			// intento previo se corto DESPUES de que el Fact lo procesara, el
			// reintento ya no encuentra los chunks anteriores (se limpian al
			// publicar) y responde chunk_assemble_failed aunque si quedo publicada.
			if i == n-1 && netErr && strings.Contains(err.Error(), "chunk_assemble_failed") {
				err = fmt.Errorf("%w\n\n   OJO: un intento anterior del ultimo chunk se corto en la red; la publicacion\n   puede haber quedado hecha. Revisar el panel antes de volver a desplegar", err)
			}
			return nil, fmt.Errorf("%w (tras %d intentos)", err, attempt)
		}
		wait := waits[attempt-1]
		fmt.Printf("     ! chunk %d/%d intento %d/%d fallo: %v — reintentando en %s\n",
			i+1, n, attempt, deployChunkAttempts, err, wait)
		time.Sleep(wait)
	}
}

func uploadInstallerChunked(uploadURL, token, exePath, exeName string, meta installerMeta) (*installerResult, error) {
	info, err := os.Stat(exePath)
	if err != nil {
		return nil, fmt.Errorf("stat exe: %w", err)
	}
	total := info.Size()
	chunkSize := deployChunkSize()
	totalChunks := int((total + chunkSize - 1) / chunkSize)
	if totalChunks < 1 {
		totalChunks = 1
	}
	uploadID := fmt.Sprintf("inst-%d", time.Now().UnixNano())

	if totalChunks == 1 {
		fmt.Printf("   EXE %d bytes — envío directo (1 chunk)\n", total)
	} else {
		fmt.Printf("   EXE %d bytes — %d chunks de %d bytes (upload_id=%s)\n",
			total, totalChunks, chunkSize, uploadID)
	}

	client := &http.Client{Timeout: deployChunkTimeout}

	for i := 0; i < totalChunks; i++ {
		offset := int64(i) * chunkSize
		size := chunkSize
		if offset+size > total {
			size = total - offset
		}
		fmt.Printf("   → chunk %d/%d (%d bytes)\n", i+1, totalChunks, size)
		result, err := sendChunkWithRetry(i, totalChunks, func() (*installerResult, error) {
			return uploadInstallerChunkOnce(
				client, uploadURL, token, exePath, exeName,
				offset, size, i, totalChunks, uploadID, meta,
			)
		})
		if err != nil {
			return nil, fmt.Errorf("chunk %d/%d: %w", i+1, totalChunks, err)
		}
		if result != nil {
			return result, nil
		}
	}
	return nil, fmt.Errorf("sin respuesta final tras %d chunks", totalChunks)
}

func uploadInstallerChunkOnce(
	client *http.Client,
	uploadURL, token, exePath, exeName string,
	offset, size int64, chunkIndex, totalChunks int,
	uploadID string, meta installerMeta,
) (*installerResult, error) {
	pr, pw := io.Pipe()
	writer := multipart.NewWriter(pw)

	go func() {
		defer pw.Close()
		defer writer.Close()

		fields := [][2]string{
			{"version", meta.Version},
			{"channel", meta.Channel},
			{"platform", meta.Platform},
			{"notes", meta.Notes},
			{"release_notes", meta.ReleaseNotes},
			{"upload_id", uploadID},
			{"chunk_index", fmt.Sprint(chunkIndex)},
			{"total_chunks", fmt.Sprint(totalChunks)},
		}
		for _, kv := range fields {
			if err := writer.WriteField(kv[0], kv[1]); err != nil {
				pw.CloseWithError(err)
				return
			}
		}

		part, err := writer.CreateFormFile("file", exeName)
		if err != nil {
			pw.CloseWithError(err)
			return
		}
		f, err := os.Open(exePath)
		if err != nil {
			pw.CloseWithError(err)
			return
		}
		defer f.Close()
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			pw.CloseWithError(err)
			return
		}
		if _, err := io.CopyN(part, f, size); err != nil {
			pw.CloseWithError(err)
			return
		}
	}()

	req, err := http.NewRequest("POST", uploadURL, pr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	isLast := chunkIndex == totalChunks-1
	switch {
	case !isLast && resp.StatusCode == http.StatusAccepted:
		return nil, nil
	case isLast && resp.StatusCode == http.StatusOK:
		var result installerResult
		if err := json.Unmarshal(body, &result); err != nil || !result.Ok {
			return nil, fmt.Errorf("respuesta inesperada del Fact: %s", string(body))
		}
		return &result, nil
	default:
		msg := fmt.Sprintf("HTTP %d: %s", resp.StatusCode, string(body))
		if resp.StatusCode == 413 {
			msg += "\n\nEl chunk excede el límite del proxy. Reduce installerChunkSz o usa NESTOR_DEPLOY_UPLOAD_URL apuntando a un subdominio DNS-only."
		}
		return nil, &deployHTTPError{status: resp.StatusCode, msg: msg}
	}
}

func sha256File(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func main() {
	loadDotEnv()

	flagProd := flag.Bool("prod", false, "forzar canal prod")
	flagForceChannel := flag.String("force-channel", "", "forzar canal (internal|prod)")
	flagChannel := flag.String("channel", "", "canal (internal|prod)")
	flagVersion := flag.String("version", "", "override de versión (ej. 1.2.3)")
	flagPlatform := flag.String("platform", "", "override de plataforma (default nestor-client-windows)")
	flagNotes := flag.String("notes", "", "notas literales del release")
	flagNotesFile := flag.String("notes-file", "", "archivo con notas del release")
	flagYes := flag.Bool("yes", true, "omitir confirmación interactiva (default true)")
	flag.Parse()

	// 1. Leer metadata del build.
	metaRaw, err := os.ReadFile(buildMetaFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error: no se pudo leer", buildMetaFile+":", err)
		fmt.Fprintln(os.Stderr, "  Ejecuta build.go primero (o build-for-windows.bat).")
		os.Exit(1)
	}
	var meta buildMeta
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		fmt.Fprintln(os.Stderr, "Error: client_build.json inválido:", err)
		os.Exit(1)
	}

	// 2. Resolver canal / plataforma / versión (flags ganan sobre la metadata).
	channel := meta.Channel
	switch {
	case *flagForceChannel != "":
		channel = sanitizeChannel(*flagForceChannel)
	case *flagChannel != "":
		channel = sanitizeChannel(*flagChannel)
	case *flagProd:
		channel = "prod"
	case channel == "":
		channel = "prod"
	}

	platform := clientPlatform
	if *flagPlatform != "" {
		platform = *flagPlatform
	}

	version := meta.Version
	if *flagVersion != "" {
		version = *flagVersion
	}

	// 3. Localizar el .exe.
	exeName := meta.ExeName
	exePath := filepath.Join(outputDir, exeName)
	if _, err := os.Stat(exePath); err != nil {
		fmt.Fprintln(os.Stderr, "Error: no existe el instalador", exePath+":", err)
		os.Exit(1)
	}

	// 4. Endpoint + credenciales.
	endpoint := os.Getenv("NESTOR_DEPLOY_URL")
	if endpoint == "" {
		endpoint = defaultEndpoint
	}
	uploadEndpoint := os.Getenv("NESTOR_DEPLOY_UPLOAD_URL")
	if uploadEndpoint == "" {
		uploadEndpoint = endpoint
	}
	user := os.Getenv("NESTOR_DEPLOY_USER")
	pass := os.Getenv("NESTOR_DEPLOY_PASS")
	if user == "" || pass == "" {
		fmt.Fprintln(os.Stderr, "Error: NESTOR_DEPLOY_USER y NESTOR_DEPLOY_PASS deben estar definidos (en .env o el entorno).")
		os.Exit(1)
	}

	fmt.Println("→ Autenticando contra", endpoint)
	token, err := loginPanel(endpoint, user, pass)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error login:", err)
		os.Exit(1)
	}

	// Fallback de versión: si la metadata no la trae, pedirla al Fact.
	if strings.TrimSpace(version) == "" {
		version = suggestNextVersion(endpoint, token, platform, channel)
		if version == "" {
			version = "1.0.0"
		}
	}

	// 5. Notas del release.
	releaseNotes := *flagNotes
	if *flagNotesFile != "" {
		data, err := os.ReadFile(*flagNotesFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, "Error leyendo notes-file:", err)
			os.Exit(1)
		}
		releaseNotes = string(data)
	}
	if strings.TrimSpace(releaseNotes) == "" {
		log := gitOutput("log", "-15", "--pretty=format:- %h %an · %s")
		releaseNotes = fmt.Sprintf(
			"NestorPOS Client %s — build %s (%s), %s\n\n## Cambios recientes\n%s",
			version, meta.Commit, meta.Branch, meta.BuiltAt, log,
		)
	}

	// 6. Checksum informativo + resumen.
	checksum, sizeBytes, err := sha256File(exePath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "checksum falló:", err)
		os.Exit(1)
	}

	fmt.Println()
	fmt.Println("Nestor Client Deploy — Windows")
	fmt.Println("==============================")
	fmt.Println("Endpoint:      ", endpoint)
	fmt.Println("Canal:         ", channel)
	fmt.Println("Plataforma:    ", platform)
	fmt.Println("Versión:       ", version)
	fmt.Println("Instalador:    ", exePath)
	fmt.Printf("Tamaño:         %d bytes (%.1f MB)\n", sizeBytes, float64(sizeBytes)/(1024*1024))
	fmt.Println("SHA256:        ", checksum)
	fmt.Println()

	if !*flagYes && isInteractive() && !confirm("¿Continuar con el upload?") {
		fmt.Println("Cancelado por el usuario.")
		os.Exit(0)
	}

	// 7. Upload.
	uploadURL := uploadEndpoint + "/panel/v1/installers"
	fmt.Println("→ Subiendo a", uploadURL)
	result, err := uploadInstallerChunked(uploadURL, token, exePath, exeName, installerMeta{
		Version:      version,
		Channel:      channel,
		Platform:     platform,
		Notes:        fmt.Sprintf("Subido por deploy.go desde %s (%s)", meta.Branch, meta.Commit),
		ReleaseNotes: releaseNotes,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "upload falló:", err)
		os.Exit(1)
	}

	downloadURL := fmt.Sprintf("%s/downloads/latest/%s.exe?channel=%s", endpoint, platform, channel)
	fmt.Println()
	fmt.Println("✓ Instalador publicado.")
	fmt.Printf("  ID:           %d\n", result.ID)
	fmt.Printf("  Versión:      %s\n", result.Version)
	fmt.Printf("  Build number: %d\n", result.BuildNumber)
	fmt.Printf("  Canal:        %s\n", result.Channel)
	fmt.Printf("  Plataforma:   %s\n", result.Platform)
	fmt.Printf("  Checksum:     %s\n", result.Checksum)
	fmt.Println()
	fmt.Println("  Descarga estable:")
	fmt.Println("   ", downloadURL)
}

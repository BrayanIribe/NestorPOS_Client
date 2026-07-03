//go:build ignore
// +build ignore

// build.go — compila el instalador Windows (NSIS) de NestorPOS_Client.
//
// Ejecutar con: go run build.go [--version=X.Y.Z] [--prod|--channel=internal|prod]
//
// Flujo:
//   1. Resuelve el canal (rama git: master/main→prod, resto→internal; override
//      con --prod / --channel / --force-channel).
//   2. Resuelve la versión a "quemar" en el instalador:
//        a. --version=X.Y.Z  o  env NESTOR_BUILD_VERSION (override manual), si no
//        b. consulta la última versión publicada al Fact
//           (/api/v1/updates/feed?platform=nestor-client-windows) y bumpea el patch,
//        c. fallback "1.0.0".
//   3. npm install  +  npx electron-builder --win  (con la versión inyectada vía
//      -c.extraMetadata.version, sin tocar package.json).
//   4. Localiza el .exe generado en output/ y escribe output/client_build.json
//      con {version, channel, platform, exe_name, commit, built_at} para que
//      deploy.go suba exactamente ese artefacto con la misma versión.
//
// Solo usa la librería estándar de Go: NestorPOS_Client no tiene go.mod, así que
// `go run build.go` debe funcionar sin dependencias externas.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	factEndpointDefault = "https://pos-api.tecpyme.mx"
	clientPlatform      = "nestor-client-windows"
	outputDir           = "output"
	buildMetaFile       = "output/client_build.json"
)

// buildMeta es el contrato entre build.go y deploy.go. Se escribe dentro de
// output/ (ignorado por git) tras un build exitoso.
type buildMeta struct {
	Version  string `json:"version"`
	Channel  string `json:"channel"`
	Platform string `json:"platform"`
	ExeName  string `json:"exe_name"` // basename del instalador dentro de output/
	Commit   string `json:"commit"`
	Branch   string `json:"branch"`
	BuiltAt  string `json:"built_at"`
}

// loadDotEnv carga .env / .env.local del cwd sin pisar variables ya definidas
// en el entorno del sistema (misma semántica que godotenv.Load).
func loadDotEnv() {
	for _, p := range []string{".env", ".env.local"} {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
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
			val := strings.TrimSpace(line[eq+1:])
			val = strings.Trim(val, `"'`)
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

// argValue busca --key=valor o --key valor entre los argumentos y devuelve el
// valor (y si se encontró). Acepta tanto una como dos rayas.
func argValue(args []string, key string) (string, bool) {
	dash1, dash2 := "-"+key, "--"+key
	for i, a := range args {
		switch {
		case strings.HasPrefix(a, dash2+"="):
			return a[len(dash2)+1:], true
		case strings.HasPrefix(a, dash1+"="):
			return a[len(dash1)+1:], true
		case a == dash1 || a == dash2:
			if i+1 < len(args) {
				return args[i+1], true
			}
			return "", true
		}
	}
	return "", false
}

func argBool(args []string, key string) bool {
	for _, a := range args {
		if a == "-"+key || a == "--"+key {
			return true
		}
	}
	return false
}

// resolveChannel: --force-channel / --channel / --prod tienen prioridad; si no,
// se deriva de la rama git (master/main→prod, resto→internal).
func resolveChannel(args []string) string {
	if v, ok := argValue(args, "force-channel"); ok && v != "" {
		return sanitizeChannel(v)
	}
	if v, ok := argValue(args, "channel"); ok && v != "" {
		return sanitizeChannel(v)
	}
	if argBool(args, "prod") {
		return "prod"
	}
	switch gitOutput("rev-parse", "--abbrev-ref", "HEAD") {
	case "master", "main":
		return "prod"
	default:
		return "internal"
	}
}

func sanitizeChannel(ch string) string {
	switch strings.TrimSpace(ch) {
	case "internal":
		return "internal"
	default:
		return "prod"
	}
}

// fetchCurrentFactVersion consulta la última versión publicada del instalador
// del cliente. Devuelve "" si el Fact no responde o no hay release.
func fetchCurrentFactVersion(channel string) string {
	endpoint := os.Getenv("NESTOR_API_ENDPOINT")
	if endpoint == "" {
		endpoint = os.Getenv("NESTOR_DEPLOY_URL")
	}
	if endpoint == "" {
		endpoint = factEndpointDefault
	}
	url := fmt.Sprintf("%s/api/v1/updates/feed?channel=%s&platform=%s", endpoint, channel, clientPlatform)

	client := &http.Client{Timeout: 6 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		fmt.Println("[warn] no se pudo consultar versión al Fact:", err)
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Println("[warn] Fact respondió", resp.StatusCode, "al consultar versión")
		return ""
	}
	var body struct {
		Release *struct {
			Version string `json:"version"`
		} `json:"release"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.Release == nil {
		return ""
	}
	return strings.TrimSpace(body.Release.Version)
}

// bumpPatch normaliza a triplete semver e incrementa el patch.
//   "1.0"   → "1.0.1"    "1.0.4" → "1.0.5"    "2" → "2.0.1"
func bumpPatch(v string) string {
	parts := strings.Split(strings.TrimSpace(v), ".")
	nums := [3]int{}
	for i := 0; i < 3; i++ {
		if i < len(parts) {
			n, _ := strconv.Atoi(strings.TrimSpace(parts[i]))
			nums[i] = n
		}
	}
	nums[2]++
	return fmt.Sprintf("%d.%d.%d", nums[0], nums[1], nums[2])
}

// resolveVersion aplica el orden: --version / NESTOR_BUILD_VERSION → feed+bump → 1.0.0.
func resolveVersion(args []string, channel string) string {
	if v, ok := argValue(args, "version"); ok && strings.TrimSpace(v) != "" {
		fmt.Println("=> BuildVersion (desde --version):", v)
		return strings.TrimSpace(v)
	}
	if v := strings.TrimSpace(os.Getenv("NESTOR_BUILD_VERSION")); v != "" {
		fmt.Println("=> BuildVersion (desde NESTOR_BUILD_VERSION):", v)
		return v
	}
	fmt.Printf("=> Consultando última versión al Fact (channel=%s platform=%s)…\n", channel, clientPlatform)
	if cur := fetchCurrentFactVersion(channel); cur != "" {
		next := bumpPatch(cur)
		fmt.Printf("=> BuildVersion: %s (bump de %s publicada en el Fact)\n", next, cur)
		return next
	}
	fmt.Println("=> BuildVersion fallback: 1.0.0")
	return "1.0.0"
}

// findInstallerExe localiza el .exe del instalador en output/ (no recursivo).
// Prefiere el que contiene "Setup" (nombre por defecto de NSIS) y descarta
// blockmaps.
func findInstallerExe() (string, error) {
	entries, err := os.ReadDir(outputDir)
	if err != nil {
		return "", fmt.Errorf("no se pudo leer %s/: %w", outputDir, err)
	}
	var candidates []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		low := strings.ToLower(name)
		if strings.HasSuffix(low, ".exe") && !strings.HasSuffix(low, ".blockmap") {
			candidates = append(candidates, name)
		}
	}
	if len(candidates) == 0 {
		return "", fmt.Errorf("no se encontró ningún .exe en %s/", outputDir)
	}
	for _, c := range candidates {
		if strings.Contains(strings.ToLower(c), "setup") {
			return c, nil
		}
	}
	return candidates[0], nil
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	fmt.Println("Running:", append([]string{name}, args...))
	return cmd.Run()
}

func main() {
	loadDotEnv()
	args := os.Args[1:]

	channel := resolveChannel(args)
	version := resolveVersion(args, channel)
	commit := gitOutput("rev-parse", "--short", "HEAD")
	branch := gitOutput("rev-parse", "--abbrev-ref", "HEAD")
	ts := time.Now().UTC().Format("2006-01-02T15:04:05Z")

	fmt.Println("========================================")
	fmt.Println(" NestorPOS Client — Build Windows (NSIS)")
	fmt.Println("========================================")
	fmt.Println(" Date:    ", ts)
	fmt.Println(" Branch:  ", branch)
	fmt.Println(" Commit:  ", commit)
	fmt.Println(" Channel: ", channel)
	fmt.Println(" Version: ", version)
	fmt.Println(" Platform:", clientPlatform)
	fmt.Println("========================================")

	// 1. Dependencias.
	fmt.Println("\n=> npm install…")
	if err := run("npm", "install"); err != nil {
		fmt.Fprintln(os.Stderr, "npm install falló:", err)
		os.Exit(1)
	}

	// 2. Instalador Windows. La versión se inyecta vía extraMetadata para no
	//    ensuciar package.json en git. --publish never evita que electron-builder
	//    intente publicar a un provider por su cuenta.
	fmt.Println("\n=> electron-builder --win…")
	if err := run("npx", "electron-builder", "--win",
		"-c.extraMetadata.version="+version, "--publish", "never"); err != nil {
		fmt.Fprintln(os.Stderr, "electron-builder falló:", err)
		os.Exit(1)
	}

	// 3. Localizar el instalador y escribir metadata para deploy.go.
	exeName, err := findInstallerExe()
	if err != nil {
		fmt.Fprintln(os.Stderr, "No se encontró el instalador:", err)
		os.Exit(1)
	}
	exePath := filepath.Join(outputDir, exeName)
	info, _ := os.Stat(exePath)

	meta := buildMeta{
		Version:  version,
		Channel:  channel,
		Platform: clientPlatform,
		ExeName:  exeName,
		Commit:   commit,
		Branch:   branch,
		BuiltAt:  ts,
	}
	metaJSON, _ := json.MarshalIndent(meta, "", "  ")
	if err := os.WriteFile(buildMetaFile, metaJSON, 0644); err != nil {
		fmt.Fprintln(os.Stderr, "No se pudo escribir", buildMetaFile+":", err)
		os.Exit(1)
	}

	fmt.Println("\n========================================")
	fmt.Println(" BUILD OK")
	fmt.Println("========================================")
	fmt.Println(" Instalador:", exePath)
	if info != nil {
		fmt.Printf(" Tamaño:     %.1f MB\n", float64(info.Size())/(1024*1024))
	}
	fmt.Println(" Metadata:  ", buildMetaFile)
	fmt.Println("========================================")
	fmt.Println("\n🎉 Build completado. Ahora deploy.go subirá este instalador al Fact.")
}

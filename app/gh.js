// Reads decks from the private GitHub repository the Publish plugin writes to.
const API = "https://api.github.com";

export class Repo {
  constructor(full, token) { this.full = full; this.token = token; }

  async request(path, accept = "application/vnd.github+json", init = {}) {
    const res = await fetch(`${API}/repos/${this.full}${path}`, {
      ...init,
      headers: { Accept: accept, Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2022-11-28", ...(init.headers || {}) },
    });
    if (!res.ok) {
      const err = new Error(res.status === 401 ? "GitHub rejected the access token." : res.status === 404 ? `Not found: ${path}` : `GitHub error ${res.status} on ${path}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  async listDecks() {
    let entries;
    try { entries = await (await this.request("/contents/decks")).json(); }
    catch (err) { if (err.status === 404) return []; throw err; }
    const dirs = entries.filter(e => e.type === "dir");
    const decks = await Promise.all(dirs.map(async d => {
      try { return JSON.parse(await this.text(`decks/${d.name}/deck.json`)); } catch { return null; }
    }));
    return decks.filter(Boolean);
  }

  async text(path) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return (await this.request(`/contents/${encoded}`, "application/vnd.github.raw+json")).text();
  }

  async blob(sha) {
    return (await this.request(`/git/blobs/${sha}`, "application/vnd.github.raw+json")).arrayBuffer();
  }

  async shaderSource(version) {
    try { return await this.text(`shaders/${version}.js`); }
    catch (err) { if (err.status === 404) return null; throw err; }
  }

  // Files in a top-level folder of the repository: [{ name, sha }].
  async list(dir) {
    try { return (await (await this.request(`/contents/${dir}`)).json()).filter(e => e.type === "file").map(e => ({ name: e.name, sha: e.sha })); }
    catch (err) { if (err.status === 404) return []; throw err; }
  }

  // Adds a binary file (a video) to the repository; returns its blob sha.
  async putFile(path, bytes, message) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const res = await this.request(`/contents/${path}`, undefined, { method: "PUT", body: JSON.stringify({ message, content: btoa(bin) }) });
    return (await res.json()).content.sha;
  }

  // Adds a shader source file (downloaded from Figma's code viewer) to the repository.
  async putShader(version, source) {
    const bytes = new TextEncoder().encode(source);
    let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
    await this.request(`/contents/shaders/${version}.js`, undefined, {
      method: "PUT", body: JSON.stringify({ message: `Add shader ${version.slice(0, 8)}`, content: btoa(bin) }),
    });
  }
}

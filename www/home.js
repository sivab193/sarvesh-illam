/* Sarvesh Illam home controls. Home Assistant credentials stay server-side. */
(() => {
  // Docker uses same-origin proxy routes. The fallback keeps the legacy
  // go2rtc-served dashboard and Android shell compatible with port 8090.
  const apiUrl = new URL(HOST);
  apiUrl.port = "8090";
  apiUrl.pathname = "";
  const API = window.SARVESH_API_ORIGIN || apiUrl.origin;
  const view = document.getElementById("homeView");
  let config = null;
  let music = null;
  let musicStream = null;
  let audioContext = null;
  let analyser = null;
  let musicFrame = null;
  let lastMusicSend = 0;
  let smoothedLevel = 0;
  let lastBass = 0;
  let musicHue = 210;
  let lastStates = [];
  let homeMode = localStorage.getItem("sarveshHomeMode") || "room";
  const clientId = localStorage.getItem("sarveshMusicClient") ||
    (crypto.randomUUID ? crypto.randomUUID() : `client-${Date.now()}-${Math.random()}`);
  localStorage.setItem("sarveshMusicClient", clientId);
  const clientName = /Android/i.test(navigator.userAgent) ? "Android app" :
    /iPhone|iPad/i.test(navigator.userAgent) ? "iPhone or iPad" : "This dashboard";

  const esc = value => String(value).replace(/[&<>'"]/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"})[c]);
  function renderNotice(title, text){
    view.innerHTML = `<div class="home-empty"><div class="home-empty-icon">⌂</div><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;
  }
  function stateLabel(device){
    if (device.type === "sensor") {
      const unit = device.attributes?.unit_of_measurement || "";
      return `${device.state} ${unit}`.trim();
    }
    if (device.state === "unavailable" || device.state === "unknown") return "Offline";
    if (device.state === "on") {
      const watts = device.attributes?.power;
      return watts == null ? "On" : `On · ${Number(watts).toFixed(1)} W`;
    }
    return "Off";
  }
  function deviceGroups(devices){
    const groups = new Map();
    const ungrouped = [];
    for (const device of devices) {
      if (!device.device_id) { ungrouped.push(device); continue; }
      if (!groups.has(device.device_id)) groups.set(device.device_id, {
        id: device.device_id,
        name: device.device_name || "Connected device",
        outlets: [],
      });
      groups.get(device.device_id).outlets.push(device);
    }
    return {groups: [...groups.values()], ungrouped};
  }
  function roomDevices(devices){
    const {groups, ungrouped} = deviceGroups(devices);
    const grouped = groups.map(group => `<div class="device-group">
      <div class="device-group-head"><div><h3>${esc(group.name)}</h3><p>${group.outlets.length} ${group.outlets.length === 1 ? "outlet" : "outlets"} · Local power strip</p></div>
      <button class="room-button room-off" data-device-off="${esc(group.outlets.map(outlet => outlet.id).join(","))}" ${group.outlets.some(outlet => !outlet.read_only && outlet.state !== "unavailable") ? "" : "disabled"}>Turn off device</button></div>
      <div class="device-grid">${group.outlets.map(card).join("")}</div>
    </div>`).join("");
    const standalone = ungrouped.length ? `<div class="device-grid">${ungrouped.map(card).join("")}</div>` : "";
    return grouped + standalone || `<p class="room-empty">No devices in this room yet.</p>`;
  }
  function sceneShape(kind){
    if (kind === "msi") return `<span class="scene-object monitor-object"><span class="monitor-screen"><i></i></span><span class="monitor-neck"></span><span class="monitor-foot"></span></span>`;
    if (kind === "hp") return `<span class="scene-object monitor-object portrait"><span class="monitor-screen"><i></i></span><span class="monitor-neck"></span><span class="monitor-foot"></span></span>`;
    if (kind === "alexa") return `<span class="scene-object alexa-object"><span class="alexa-ring"></span><span class="alexa-dot"></span></span>`;
    if (kind === "lamp") return `<span class="lamp-beam"></span><span class="scene-object lamp-object"><span class="lamp-shade"></span><span class="lamp-arm"></span><span class="lamp-base"></span></span>`;
    return `<span class="scene-object fan-object"><span class="fan-top"></span><span class="fan-grille"><i></i><i></i><i></i></span><span class="fan-base"></span></span>`;
  }
  function sceneControl(device, kind, fallbackName){
    if (!device) return "";
    const online = !["unavailable", "unknown"].includes(device.state);
    const on = device.state === "on";
    return `<button class="scene-control scene-${kind} ${on ? "is-on" : "is-off"} ${online ? "" : "is-offline"}" data-command="${on ? "turn_off" : "turn_on"}" data-id="${esc(device.id)}" ${online ? "" : "disabled"} aria-label="${esc(`${on ? "Turn off" : "Turn on"} ${device.name || fallbackName}`)}">
      ${sceneShape(kind)}
      <span class="scene-device-label"><strong>${esc(device.name || fallbackName)}</strong><small><i></i>${esc(stateLabel(device))}</small></span>
    </button>`;
  }
  function studyRoomScene(devices){
    const find = text => devices.find(device => device.name.toLowerCase().includes(text));
    const hp = find("hp monitor");
    const msi = find("msi monitor");
    const alexa = find("alexa");
    const lamp = find("table light");
    const fan = find("fan");
    return `<div class="room-visual ${lamp?.state === "on" ? "has-lamp-light" : ""}">
      <div class="room-visual-copy"><div><h3>Interactive room</h3><p>Tap a powered item to switch it on or off.</p></div><span class="room-live-key"><i></i>Live state</span></div>
      <div class="room-model" role="group" aria-label="Interactive 3D visualization of the Study Room">
        <div class="room-back-wall"></div><div class="room-side-wall"></div><div class="room-floor-plane"></div>
        <div class="scene-window" aria-hidden="true"><i></i><i></i></div>
        <div class="scene-cabinet" aria-hidden="true"><i></i></div>
        <div class="scene-bed" aria-hidden="true"><span></span></div>
        <div class="scene-desk" aria-hidden="true"><span class="desk-top"></span><i class="desk-leg left"></i><i class="desk-leg right"></i><span class="scene-keyboard"></span><span class="scene-mouse"></span></div>
        <div class="scene-power-strip" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        ${sceneControl(msi, "msi", "MSI monitor")}
        ${sceneControl(hp, "hp", "HP monitor")}
        ${sceneControl(alexa, "alexa", "Alexa")}
        ${sceneControl(lamp, "lamp", "Table light")}
        ${sceneControl(fan, "fan", "Fan")}
      </div>
      <p class="room-layout-note">Layout based on your video: MSI left, HP right, Alexa in front of MSI, and the light behind HP.</p>
    </div>`;
  }
  function roomContent(room, devices){
    if (homeMode === "room" && room.toLowerCase() === "study room") return studyRoomScene(devices);
    return roomDevices(devices);
  }
  function render(states){
    lastStates = states;
    const rooms = new Map();
    for (const room of config?.rooms || []) rooms.set(room, []);
    for (const device of states) rooms.set(device.room, [...(rooms.get(device.room) || []), device]);
    view.innerHTML = `<div class="home-head"><div><h1>Home</h1><p>Control your connected devices locally.</p></div><div class="home-actions"><div class="home-mode" role="group" aria-label="Home display"><button data-home-mode="room" class="${homeMode === "room" ? "on" : ""}">Room view</button><button data-home-mode="controls" class="${homeMode === "controls" ? "on" : ""}">Controls</button></div><button class="home-refresh" id="homeAddRoom">＋ Room</button><button class="home-refresh" id="homeAddDevice">＋ Device</button><button class="home-refresh" id="homeRefresh">↻ Refresh</button></div></div>${musicCard()}` +
      [...rooms].map(([room, devices]) => `<section class="room"><div class="room-head"><h2>${esc(room)}</h2><div><button class="room-button" data-room-edit="${esc(room)}">Edit</button><button class="room-button room-off" data-room-off="${esc(room)}" ${devices.some(device => !device.read_only && ["light", "switch"].includes(device.type)) ? "" : "disabled"}>Turn off room</button></div></div>${roomContent(room, devices)}</section>`).join("");
    document.getElementById("homeRefresh").onclick = load;
    document.getElementById("homeAddRoom").onclick = addRoom;
    document.getElementById("homeAddDevice").onclick = addDevice;
    view.querySelectorAll("[data-home-mode]").forEach(button => button.onclick = () => {
      homeMode = button.dataset.homeMode;
      localStorage.setItem("sarveshHomeMode", homeMode);
      render(lastStates);
    });
    view.querySelectorAll("[data-command]").forEach(button => button.onclick = () => command(button));
    view.querySelectorAll("input[data-brightness]").forEach(input => input.onchange = () =>
      command(input, "set", {brightness_pct: Number(input.value)}));
    view.querySelectorAll("input[data-color-temp]").forEach(input => input.onchange = () =>
      command(input, "set", {color_temp_kelvin: Number(input.value)}));
    view.querySelectorAll("input[data-color]").forEach(input => input.onchange = () => {
      const hex = input.value.slice(1);
      command(input, "set", {rgb_color: [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16))});
    });
    view.querySelectorAll("select[data-effect]").forEach(select => select.onchange = () =>
      command(select, "set", {effect: select.value}));
    const musicButton = document.getElementById("musicReactive");
    if (musicButton) musicButton.onclick = () => {
      if (music?.active && music.owner?.id === clientId) stopMusic();
      else startMusic(Boolean(music?.active));
    };
    const musicStop = document.getElementById("musicStop");
    if (musicStop) musicStop.onclick = () => stopMusic(true);
    view.querySelectorAll("[data-room-off]").forEach(button => button.onclick = () => turnOffRoom(button));
    view.querySelectorAll("[data-device-off]").forEach(button => button.onclick = () => turnOffDevice(button));
    view.querySelectorAll("[data-room-edit]").forEach(button => button.onclick = () => renameRoom(button.dataset.roomEdit));
    view.querySelectorAll("[data-edit-device]").forEach(button => button.onclick = () => editDevice(button.dataset.editDevice));
    view.querySelectorAll("[data-remove-device]").forEach(button => button.onclick = () => removeDevice(button.dataset.removeDevice));
  }
  function musicCard(){
    const active = music?.active;
    const mine = active && music.owner?.id === clientId;
    const owner = music?.owner?.name || "another device";
    const label = mine ? "Stop music reactive" : active ? "Take over audio" : "Start music reactive";
    const detail = mine ? "Your microphone is driving the living-room light." : active ?
      `Running from ${owner}. Taking over switches the audio source to this device.` :
      "Use this device's microphone to make the light respond to any nearby music.";
    return `<section class="music-card ${active ? "is-active" : ""}"><div class="music-icon">♫</div><div class="music-copy"><h2>Music reactive</h2><p>${esc(detail)}</p></div><div class="music-actions"><button id="musicReactive" class="music-toggle">${label}</button>${active && !mine ? `<button id="musicStop" class="music-stop">Stop</button>` : ""}</div></section>`;
  }
  function card(device){
    const online = !["unavailable", "unknown"].includes(device.state);
    const on = device.state === "on";
    const controllable = device.type !== "sensor" && !device.read_only;
    const brightness = Math.round((device.attributes?.brightness || 255) / 255 * 100);
    const modes = device.attributes?.supported_color_modes || [];
    const supportsTemp = modes.includes("color_temp");
    const supportsColor = modes.some(mode => ["hs", "rgb", "rgbw", "rgbww"].includes(mode));
    const minTemp = device.attributes?.min_color_temp_kelvin || 2200;
    const maxTemp = device.attributes?.max_color_temp_kelvin || 6500;
    const colorTemp = device.attributes?.color_temp_kelvin || Math.round((minTemp + maxTemp) / 2);
    const rgb = device.attributes?.rgb_color || device.attributes?.rgbw_color || [255, 255, 255];
    const color = "#" + rgb.slice(0, 3).map(value => Math.max(0, Math.min(255, Number(value))).toString(16).padStart(2, "0")).join("");
    const effects = device.attributes?.effect_list || [];
    return `<article class="device-card ${on ? "is-on" : ""} ${online ? "" : "is-offline"}">
      <div class="device-top"><span class="device-icon">${esc(device.icon)}</span><span class="device-state">${esc(stateLabel(device))}</span></div>
      <h3>${esc(device.name)}</h3><p>${esc(device.read_only ? "State visible · control pending WiZ fix" : device.type === "light" ? "Smart light" : device.type === "sensor" ? "Live measurement" : "Smart plug")}</p>
      ${controllable ? `<div class="device-actions"><button class="device-toggle" data-command="${on ? "turn_off" : "turn_on"}" data-id="${esc(device.id)}" ${online ? "" : "disabled"}>${on ? "Turn off" : "Turn on"}</button></div>` : ""}
      ${device.type === "light" && controllable ? `<label class="brightness">Brightness <span>${brightness}%</span><input data-brightness data-id="${esc(device.id)}" type="range" min="1" max="100" value="${brightness}" ${online ? "" : "disabled"}></label>` : ""}
      ${device.type === "light" && controllable && supportsTemp ? `<label class="brightness">Colour temperature <span>${colorTemp} K</span><input data-color-temp data-id="${esc(device.id)}" type="range" min="${minTemp}" max="${maxTemp}" value="${colorTemp}" ${online ? "" : "disabled"}></label>` : ""}
      ${device.type === "light" && controllable && supportsColor ? `<label class="brightness">Colour <input data-color data-id="${esc(device.id)}" type="color" value="${color}" ${online ? "" : "disabled"}></label>` : ""}
      ${device.type === "light" && controllable && effects.length ? `<label class="brightness">Effect <select data-effect data-id="${esc(device.id)}" ${online ? "" : "disabled"}>${effects.map(effect => `<option value="${esc(effect)}" ${effect === device.attributes?.effect ? "selected" : ""}>${esc(effect)}</option>`).join("")}</select></label>` : ""}
      <div class="device-manage"><button data-edit-device="${esc(device.id)}">Edit</button><button data-remove-device="${esc(device.id)}">Remove</button></div>
    </article>`;
  }
  async function command(control, action = control.dataset.command, data = {}){
    const id = control.dataset.id;
    if (!id) return;
    control.disabled = true;
    try {
      const r = await fetch(`${API}/api/home/entities/${encodeURIComponent(id)}`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action, data})});
      if (!r.ok) throw new Error();
      setTimeout(load, 350);
    } catch (_) { alert("Device control failed. Check the Sarvesh Illam service and Home Assistant."); }
    finally { control.disabled = false; }
  }
  async function manage(path, method, body){
    const options = {method, headers: {"Content-Type": "application/json"}};
    if (body) options.body = JSON.stringify(body);
    const r = await fetch(`${API}/api/home${path}`, options);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Could not save dashboard changes");
    return r.json();
  }
  async function addRoom(){
    const name = prompt("Room name"); if (!name?.trim()) return;
    try { await manage("/rooms", "POST", {name}); await load(); } catch (error) { alert(error.message); }
  }
  async function renameRoom(room){
    const name = prompt("Rename room", room); if (!name?.trim() || name === room) return;
    try { await manage(`/rooms/${encodeURIComponent(room)}`, "PATCH", {name}); await load(); } catch (error) { alert(error.message); }
  }
  async function addDevice(){
    const entity_id = prompt("Home Assistant entity ID (for example light.living_room_lamp)");
    if (!entity_id?.trim()) return;
    const name = prompt("Display name", entity_id) || entity_id;
    const room = prompt("Room", config?.rooms?.[0] || "Home") || "Home";
    const icon = prompt("Icon", entity_id.startsWith("light.") ? "💡" : entity_id.startsWith("switch.") ? "🔌" : "◌") || "⌂";
    try { await manage("/entities", "POST", {entity_id, name, room, icon}); await load(); } catch (error) { alert(error.message); }
  }
  async function editDevice(id){
    const device = (await fetch(`${API}/api/home/states`).then(r => r.json())).find(item => item.id === id);
    if (!device) return;
    const name = prompt("Display name", device.name); if (!name?.trim()) return;
    const room = prompt("Room", device.room); if (!room?.trim()) return;
    const icon = prompt("Icon", device.icon); if (!icon?.trim()) return;
    try { await manage(`/entities/${encodeURIComponent(id)}`, "PATCH", {name, room, icon}); await load(); } catch (error) { alert(error.message); }
  }
  async function removeDevice(id){
    if (!confirm("Remove this device from the dashboard? It will stay in Home Assistant.")) return;
    try { await manage(`/entities/${encodeURIComponent(id)}`, "DELETE"); await load(); } catch (error) { alert(error.message); }
  }
  async function turnOffRoom(button){
    const room = button.dataset.roomOff;
    if (!confirm(`Turn off all controllable devices in ${room}?`)) return;
    button.disabled = true;
    try { await manage(`/rooms/${encodeURIComponent(room)}/turn_off`, "POST"); setTimeout(load, 400); }
    catch (error) { alert(error.message); button.disabled = false; }
  }
  async function turnOffDevice(button){
    const ids = button.dataset.deviceOff.split(",").filter(Boolean);
    if (!confirm("Turn off every outlet on this device?")) return;
    button.disabled = true;
    try {
      for (const id of ids) {
        const response = await fetch(`${API}/api/home/entities/${encodeURIComponent(id)}`, {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({action: "turn_off", data: {}}),
        });
        if (!response.ok) throw new Error();
      }
      setTimeout(load, 400);
    } catch (_) {
      alert("Some outlets could not be turned off. Check that the power strip is online.");
      button.disabled = false;
    }
  }
  async function musicRequest(path, body){
    const r = await fetch(`${API}/api/home/music-reactive${path}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Music reactive mode failed");
    return r.json();
  }
  async function startMusic(takeOver){
    try {
      musicStream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.65;
      audioContext.createMediaStreamSource(musicStream).connect(analyser);
      music = await musicRequest("/claim", {client_id: clientId, name: clientName, take_over: takeOver});
      animateMusic(); load();
    } catch (error) {
      stopLocalAudio();
      alert(error.message || "Microphone access is required for music reactive mode.");
      load();
    }
  }
  function animateMusic(){
    if (!analyser) return;
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const tick = now => {
      if (!analyser) return;
      analyser.getByteFrequencyData(bins);
      const bass = bins.slice(1, 12).reduce((sum, value) => sum + value, 0) / (11 * 255);
      const energy = bins.slice(1, 80).reduce((sum, value) => sum + value, 0) / (79 * 255);
      smoothedLevel = smoothedLevel * 0.72 + energy * 0.28;
      const beat = bass > Math.max(0.19, lastBass * 1.32);
      lastBass = lastBass * 0.84 + bass * 0.16;
      if (beat) musicHue = (musicHue + 37) % 360;
      if (now - lastMusicSend > 300) {
        lastMusicSend = now;
        musicRequest("/level", {client_id: clientId, level: smoothedLevel, beat, hue: musicHue})
          .catch(() => { stopLocalAudio(); load(); });
      }
      musicFrame = requestAnimationFrame(tick);
    };
    musicFrame = requestAnimationFrame(tick);
  }
  function stopLocalAudio(){
    if (musicFrame) cancelAnimationFrame(musicFrame);
    musicFrame = null;
    musicStream?.getTracks().forEach(track => track.stop());
    musicStream = null; analyser = null;
    audioContext?.close(); audioContext = null;
  }
  async function stopMusic(force = false){
    stopLocalAudio();
    try { music = await musicRequest("/stop", {client_id: clientId, take_over: force}); }
    catch (error) { alert(error.message || "Could not stop music reactive mode."); }
    load();
  }
  async function load(){
    try {
      const c = await fetch(`${API}/api/home/config`, {cache:"no-store"});
      config = await c.json();
      if (!config.configured) return renderNotice("Set up your home", "Add the Home Assistant entity IDs in alerts/config.yaml.");
      if (!config.enabled) return renderNotice("No home provider is connected", "Configure a local device in alerts/config.local.yaml or start the optional Home Assistant service.");
      const [r, musicResponse] = await Promise.all([fetch(`${API}/api/home/states`, {cache:"no-store"}), fetch(`${API}/api/home/music-reactive`, {cache:"no-store"})]);
      if (!r.ok) throw new Error();
      music = musicResponse.ok ? await musicResponse.json() : null;
      render(await r.json());
    } catch (_) { renderNotice("Home unavailable", "Sarvesh Illam could not reach Home Assistant."); }
  }
  window.addEventListener("pagehide", () => {
    if (music?.active && music.owner?.id === clientId) {
      navigator.sendBeacon(`${API}/api/home/music-reactive/stop`, new Blob([JSON.stringify({client_id: clientId})], {type: "application/json"}));
    }
    stopLocalAudio();
  });
  setInterval(() => {
    if (view.classList.contains("show")) load();
  }, 5000);
  window.SarveshHome = {load};
  load();
})();

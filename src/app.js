'use strict';

// All of the Node.js APIs are available in the preload process.
// It has the same sandbox as a Chrome extension.
// const gkm = require('gkm');
const Store = require('electron-store');
const store = new Store();
const { Howl } = require('howler');
const { shell, ipcRenderer } = require('electron');
const remote = require('@electron/remote');
const { globSync } = require('glob');
const path = require('path');
const { platform } = process;
const remapper = require('./utils/remapper');

const MV_KEYBOARD_PACK_LSID = 'mechvibes-pack';
const MV_MOUSE_PACK_LSID = 'mechvibes-mousepack';
const MV_KEY_VOL_LSID = 'mechvibes-volume-keyboard';
const MV_MOUSE_VOL_LSID = 'mechvibes-volume-mouse';

const KEYBOARD_CUSTOM_PACKS_DIR = remote.getGlobal('keyboardcustom_dir');
const KEYBOARD_OFFICIAL_PACKS_DIR = path.join(__dirname, 'sounds/keys');
const MOUSE_CUSTOM_PACKS_DIR = remote.getGlobal('mousecustom_dir');
const MOUSE_OFFICIAL_PACKS_DIR = path.join(__dirname, 'sounds/mouse');
const APP_VERSION = remote.getGlobal('app_version');
const APP_TITLE = remote.getGlobal('app_title') || 'MechVibes++ 2026';

let current_keyboard_pack = null;
let current_mouse_pack = null;
let current_sound_key = null;
let is_muted = store.get('mechvibes-muted') || false;
let is_keyup = store.get('mechvibes-keyup') || false;
let is_mousesounds = store.get('mechvibes-mouse');
if (is_mousesounds === undefined) {
  is_mousesounds = true;
}
let is_random = store.get('mechvibes-random') || false;
let keyboardpacks = [];
let mousepacks = [];
let all_sound_files = {};
const pressedMouseButtons = new Set();

const DEFAULT_KEYBOARD_VOLUME = 20;
const DEFAULT_MOUSE_VOLUME = 20;
const SOUND_WINDOW_MS = 100;
const MAX_KEY_SOUND_STARTS_PER_WINDOW = 18;
const MAX_MOUSE_SOUND_STARTS_PER_WINDOW = 5;
const MIN_KEY_SOUND_INTERVAL_MS = 6;
const MIN_MOUSE_SOUND_INTERVAL_MS = 22;
const MAX_ACTIVE_PER_SINGLE_HOWL = 8;
const MAX_ACTIVE_PER_MULTI_HOWL = 4;
const MAX_ACTIVE_MOUSE_SINGLE_HOWL = 2;
const MAX_ACTIVE_MOUSE_MULTI_HOWL = 1;
const SINGLE_HOWL_POOL = 8;
const MULTI_HOWL_POOL = 4;
const MOUSE_SINGLE_HOWL_POOL = 4;
const MOUSE_MULTI_HOWL_POOL = 2;

let keyboardVolume = normalizeVolumePercent(store.get(MV_KEY_VOL_LSID), DEFAULT_KEYBOARD_VOLUME);
let mouseVolume = normalizeVolumePercent(store.get(MV_MOUSE_VOL_LSID), DEFAULT_MOUSE_VOLUME);
const activeSoundIdsByHowl = new WeakMap();

function normalizeVolumePercent(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.min(100, Math.max(0, numericValue));
}

function volumeToHowler(value, fallback) {
  return normalizeVolumePercent(value, fallback) / 100;
}

function createHowl(soundPath, sprite = null, pool = MULTI_HOWL_POOL) {
  const options = {
    src: [soundPath],
    preload: true,
    html5: false,
    pool,
  };

  if (sprite) {
    options.sprite = sprite;
  }

  return new Howl(options);
}

function createSoundLimiter(maxStartsPerWindow, windowMs) {
  let windowStart = 0;
  let windowCount = 0;
  const lastSoundAtByKey = new Map();

  return function canStartLimitedSound(soundKey, minIntervalMs) {
    const now = Date.now();
    if (now - windowStart > windowMs) {
      windowStart = now;
      windowCount = 0;
    }

    if (windowCount >= maxStartsPerWindow) {
      return false;
    }

    const lastSoundAt = lastSoundAtByKey.get(soundKey) || 0;
    if (now - lastSoundAt < minIntervalMs) {
      return false;
    }

    lastSoundAtByKey.set(soundKey, now);
    windowCount += 1;
    return true;
  };
}

const canStartKeyboardSound = createSoundLimiter(MAX_KEY_SOUND_STARTS_PER_WINDOW, SOUND_WINDOW_MS);
const canStartMouseSound = createSoundLimiter(MAX_MOUSE_SOUND_STARTS_PER_WINDOW, SOUND_WINDOW_MS);

function forgetActiveSoundId(sound, id) {
  const activeIds = activeSoundIdsByHowl.get(sound);
  if (!activeIds) {
    return;
  }

  const index = activeIds.indexOf(id);
  if (index > -1) {
    activeIds.splice(index, 1);
  }
}

function playHowlLimited(sound, spriteId, maxActive) {
  const activeIds = activeSoundIdsByHowl.get(sound) || [];

  while (activeIds.length >= maxActive) {
    const oldestId = activeIds.shift();
    if (oldestId !== undefined) {
      sound.stop(oldestId);
    }
  }

  const id = spriteId ? sound.play(spriteId) : sound.play();
  if (id === null || id === undefined) {
    return;
  }

  activeIds.push(id);
  activeSoundIdsByHowl.set(sound, activeIds);
  sound.once('end', () => forgetActiveSoundId(sound, id), id);
  sound.once('stop', () => forgetActiveSoundId(sound, id), id);
}

function getSplitSpriteId(sound, baseSpriteId, downOrUp) {
  if (!downOrUp || downOrUp === 'null' || !sound._sprite || !sound._sprite[baseSpriteId]) {
    return baseSpriteId;
  }

  const splitSpriteId = `${baseSpriteId}-${downOrUp}`;
  sound._mvppSplitSprites = sound._mvppSplitSprites || {};

  if (!sound._mvppSplitSprites[splitSpriteId]) {
    const [start, length] = sound._sprite[baseSpriteId];
    const firstHalf = Math.floor(length / 2);
    const secondHalf = Math.max(length - firstHalf, 1);

    sound._sprite[splitSpriteId] = downOrUp === 'down'
      ? [start, Math.max(firstHalf, 1)]
      : [start + firstHalf, secondHalf];
    sound._mvppSplitSprites[splitSpriteId] = true;
  }

  return splitSpriteId;
}

function getPackFolders(directory) {
  const pattern = path.join(directory, '*/').replace(/\\/g, '/');
  return globSync(pattern, { windowsPathsNoEscape: true });
}

function getPackFolderName(folder) {
  return path.basename(path.resolve(folder));
}

function loadPackConfig(config_file) {
  delete require.cache[require.resolve(config_file)];
  return require(config_file);
}

function parseVersionParts(version) {
  return String(version || '')
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(candidate, current) {
  const next = parseVersionParts(candidate);
  const installed = parseVersionParts(current);
  const length = Math.max(next.length, installed.length);

  for (let index = 0; index < length; index++) {
    const nextPart = next[index] || 0;
    const installedPart = installed[index] || 0;
    if (nextPart > installedPart) {
      return true;
    }
    if (nextPart < installedPart) {
      return false;
    }
  }

  return false;
}

// ==================================================
// load all pack
async function loadPacks(status_display_elem, app_body) {
  // init
  status_display_elem.innerHTML = 'Loading...';
  all_sound_files = {};

  // get all audio folders
  const official_packs = getPackFolders(KEYBOARD_OFFICIAL_PACKS_DIR);
  const custom_packs = getPackFolders(KEYBOARD_CUSTOM_PACKS_DIR);
  const mouse_official_packs = getPackFolders(MOUSE_OFFICIAL_PACKS_DIR);
  const mouse_custom_packs = getPackFolders(MOUSE_CUSTOM_PACKS_DIR);
  const folders = [...official_packs, ...custom_packs];
  const mouse_folders = [...mouse_official_packs, ...mouse_custom_packs];

  let hasBrokenPack = false;

  // get pack data
  folders.map((folder) => {
      try{
        // define group by types
        const is_custom = folder.indexOf('mechvibes_custom') > -1 ? true : false;
        
        // get folder name
        const folder_name = getPackFolderName(folder);
        
        // define config file path
        const config_file = path.join(folder, 'config.json');
        
        // get pack info and defines data
        const { name, includes_numpad, sound = '', defines, key_define_type = 'single', compatibility = false } = loadPackConfig(config_file);
        
        // pack sound pack data
        const pack_data = {
          pack_id: `${is_custom ? 'custom' : 'default'}-${folder_name}`,
          group: is_custom ? 'Custom' : 'Default',
          abs_path: folder,
          key_define_type,
          compatibility,
          name,
          includes_numpad,
        };
        
        // init sound data
        if (key_define_type == 'single') {
          // define sound path
          const sound_path = path.join(folder, sound);
          const sound_data = createHowl(sound_path, keycodesRemap(defines), SINGLE_HOWL_POOL);
          Object.assign(pack_data, { sound: sound_data });
          all_sound_files[pack_data.pack_id] = false;
          // event when sound loaded
          sound_data.once('load', function () {
            all_sound_files[pack_data.pack_id] = true;
            checkIfAllSoundLoaded(status_display_elem, app_body);
          });
        } else {
          const sound_data = {};
          Object.keys(defines).map((kc) => {
            if (defines[kc]) {
              // define sound path
              const sound_path = path.join(folder, defines[kc]);
              sound_data[kc] = createHowl(sound_path, null, MULTI_HOWL_POOL);
              all_sound_files[`${pack_data.pack_id}-${kc}`] = false;
              // event when sound_data loaded
              sound_data[kc].once('load', function () {
                all_sound_files[`${pack_data.pack_id}-${kc}`] = true;
                checkIfAllSoundLoaded(status_display_elem, app_body);
              });
            }
          });
          if (Object.keys(sound_data).length) {
            Object.assign(pack_data, { sound: keycodesRemap(sound_data) });
          }
        }
        
        // push pack data to pack list
        keyboardpacks.push(pack_data);
      } catch(err){hasBrokenPack = true}
    });
    
    mouse_folders.map((folder) => {
      try{
        // define group by types
        const is_custom = folder.indexOf('mousevibes_custom') > -1 ? true : false;
        
        // get folder name
        const folder_name = getPackFolderName(folder);
        
        // define config file path
        const config_file = path.join(folder, 'config.json');
        
        // get pack info and defines data
        const { name, sound = '', defines, key_define_type = 'single'} = loadPackConfig(config_file);

        // pack sound pack data
        const pack_data = {
          pack_id: `${is_custom ? 'custom' : 'default'}-${folder_name}`,
          group: is_custom ? 'Custom' : 'Default',
          abs_path: folder,
          key_define_type,
          name,
        };

        // init sound data
        if (key_define_type == 'single') {
          // define sound path
          const sound_path = path.join(folder, sound);
          const sound_data = createHowl(sound_path, keycodesRemap(defines), MOUSE_SINGLE_HOWL_POOL);
          Object.assign(pack_data, { sound: sound_data });
          all_sound_files[pack_data.pack_id] = false;
          // event when sound loaded
          sound_data.once('load', function () {
            all_sound_files[pack_data.pack_id] = true;
            checkIfAllSoundLoaded(status_display_elem, app_body);
          });
        } else {
          const sound_data = {};
          Object.keys(defines).map((kc) => {
            if (defines[kc]) {
              // define sound path
              const sound_path = path.join(folder, defines[kc]);
              sound_data[kc] = createHowl(sound_path, null, MOUSE_MULTI_HOWL_POOL);
              all_sound_files[`${pack_data.pack_id}-${kc}`] = false;
              // event when sound_data loaded
              sound_data[kc].once('load', function () {
                all_sound_files[`${pack_data.pack_id}-${kc}`] = true;
                checkIfAllSoundLoaded(status_display_elem, app_body);
              });
            }
          });
          if (Object.keys(sound_data).length) {
            Object.assign(pack_data, { sound: keycodesRemap(sound_data) });
          }
        }

        // push pack data to pack list
        mousepacks.push(pack_data);
      } catch(err){hasBrokenPack = true}
    });

  // end load
  return hasBrokenPack;
}


// ==================================================
// check if all packs loaded
function checkIfAllSoundLoaded(status_display_elem, app_body) {
  Object.keys(all_sound_files).map((key) => {
    if (!all_sound_files[key]) {
      return false;
    }
  });
  status_display_elem.innerHTML = APP_TITLE;
  app_body.classList.remove('loading');
  return true;
}

// ==================================================
// remap keycodes from standard to os based keycodes
function keycodesRemap(defines) {
  const sprite = remapper('standard', platform, defines);
  Object.keys(sprite).map((kc) => {
    sprite[`keycode-${kc}`] = sprite[kc];
    delete sprite[kc];
  });
  return sprite;
}

// ==================================================
// get pack by id,
// if id is null,
// get saved pack

var packs = null
function getPack(korm, pack_id = null) {
  if (!pack_id) {
    if (store.get(korm=='keyboard' ? MV_KEYBOARD_PACK_LSID : MV_MOUSE_PACK_LSID)) {
      pack_id = store.get(korm=='keyboard' ? MV_KEYBOARD_PACK_LSID : MV_MOUSE_PACK_LSID);

      if(korm=='keyboard'){
        packs = keyboardpacks;
      }else{
        packs = mousepacks;
      }

      if (!getPack(korm, pack_id)) {
        return packs[0];
      }
    } else {
      return packs[0];
    }
  }
  store.set(korm=='keyboard' ? MV_KEYBOARD_PACK_LSID : MV_MOUSE_PACK_LSID, pack_id);
  return packs.find((pack) => pack.pack_id == pack_id);
}

// ==================================================
// transform pack to select option list
function packsToOptions(packs, pack_list, korm) {
  // get saved pack id
  const selected_pack_id = store.get(korm=='keyboard' ? MV_KEYBOARD_PACK_LSID : MV_MOUSE_PACK_LSID);
  const groups = [];
  packs.map((pack) => {
    const exists = groups.find((group) => group.id == pack.group);
    if (!exists) {
      const group = {
        id: pack.group,
        name: pack.group || 'Default',
        packs: [pack],
      };
      groups.push(group);
    } else {
      exists.packs.push(pack);
    }
  });

  for (let group of groups) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.name;
    optgroup.class = group.name;
    for (let pack of group.packs) {
      // check if selected
      const is_selected = selected_pack_id == pack.pack_id;
      if (is_selected) {
        // pack current pack to saved pack
        if(korm=='keyboard'){
          current_keyboard_pack = pack;
        }
        else{
          current_mouse_pack = pack;
        }
      }
      // add pack to pack list
      const opt = document.createElement('option');
      opt.text = pack.name;
      opt.value = pack.pack_id;
      opt.selected = is_selected ? 'selected' : false;
      optgroup.appendChild(opt);
    }
    pack_list.appendChild(optgroup);
  }

  // on select an option
  // update saved list id
  pack_list.addEventListener('change', (e) => {
    const selected_id = e.target.options[e.target.selectedIndex].value;
    store.set(korm=='keyboard' ? MV_KEYBOARD_PACK_LSID : MV_MOUSE_PACK_LSID, selected_id);
    if(korm=='keyboard'){
      current_keyboard_pack = getPack(korm);
    }
    else{
      current_mouse_pack = getPack(korm);
    }
  });
}

// ==================================================
// main
(function (window, document) {
  window.addEventListener('DOMContentLoaded', async () => {
    const version = document.getElementById('app-version');
    const update_available = document.getElementById('update-available');
    const new_version = document.getElementById('new-version');
    const app_logo = document.getElementById('logo');
    const app_body = document.getElementById('app-body');
    const keyboardpack_list = document.getElementById('keyboardpack-list');
    const mousepack_list = document.getElementById('mousepack-list');
    const volume_value = document.getElementById('keyboard-volume-value-display');
    const volume = document.getElementById('keyvolume');
    const mouse_volume_value = document.getElementById('mouse-volume-value-display');
    const mouse_volume = document.getElementById('mousevolume');
    const mouseslider = document.getElementById('MouseVolSlider');
    const soundpackbug = document.getElementById('soundpack-bug');
    const mouseNotification = document.getElementById('mouseSounds');
    const ApplicationBody = document.getElementById('overall-body');

    // set app version
    version.innerHTML = APP_VERSION;

    // load all packs
    const hasBrokenPack = await loadPacks(app_logo, app_body);

    if(hasBrokenPack){
      soundpackbug.classList.remove('hidden');
    }

    // transform packs to options list
    packsToOptions(keyboardpacks, keyboardpack_list, 'keyboard');
    packsToOptions(mousepacks, mousepack_list, 'mouse');

    if (current_keyboard_pack == null){
      keyboardpack_list.selectedIndex = -1;
    }

    if (current_mouse_pack == null){
      mousepack_list.selectedIndex = -1;
    }

    // check for new version
    fetch('https://api.github.com/repos/SuperDoduos/MechVibesPlusPlus-2026/releases/latest')
      .then((res) => res.json())
      .then((json) => {
        if (isNewerVersion(json.tag_name, APP_VERSION)) {
          new_version.innerHTML = json.tag_name;
          update_available.classList.remove('hidden');
        }
      });

    // a little hack for open link in browser
    Array.from(document.getElementsByClassName('open-in-browser')).forEach((elem) => {
      elem.addEventListener('click', (e) => {
        e.preventDefault();
        shell.openExternal(e.target.href);
      });
    });

    // get last selected pack
    try {
      current_keyboard_pack = getPack('keyboard');
      current_mouse_pack = getPack('mouse');
    } catch {
      soundpackbug.classList.remove('hidden');
    };

    // display volume value
    volume.value = keyboardVolume;
    volume_value.innerHTML = keyboardVolume;
    volume.oninput = function (e) {
      keyboardVolume = normalizeVolumePercent(this.value, DEFAULT_KEYBOARD_VOLUME);
      volume_value.innerHTML = keyboardVolume;
      store.set(MV_KEY_VOL_LSID, keyboardVolume);
    };

    mouse_volume.value = mouseVolume;
    mouse_volume_value.innerHTML = mouseVolume;
    mouse_volume.oninput = function (e) {
      mouseVolume = normalizeVolumePercent(this.value, DEFAULT_MOUSE_VOLUME);
      mouse_volume_value.innerHTML = mouseVolume;
      store.set(MV_MOUSE_VOL_LSID, mouseVolume);
    };

    function removeOptions(selectElement) {
      selectElement.replaceChildren();
    }

    ipcRenderer.on("refresh", async () => {
      removeOptions(keyboardpack_list);
      removeOptions(mousepack_list);
      
      keyboardpacks = [];
      mousepacks = [];

      const hasBrokenPackAfterRefresh = await loadPacks(app_logo, app_body);
      if (hasBrokenPackAfterRefresh) {
        soundpackbug.classList.remove('hidden');
      }


      // transform packs to options list
      packsToOptions(keyboardpacks, keyboardpack_list, 'keyboard');
      packsToOptions(mousepacks, mousepack_list, 'mouse');

      app_logo.innerHTML = APP_TITLE;
    })

    // listen to key press
    ipcRenderer.on('muted', function (_event, _is_muted) {
      is_muted = _is_muted;
    });
    
    var playKeyupSound

    if(is_keyup){
      playKeyupSound = true
    }

    ipcRenderer.on('theKeyup', function (_event, _is_keyup) {
      is_keyup = _is_keyup;
      if (is_keyup) {
        playKeyupSound = true
      } else {
        playKeyupSound = false
      }
    });

    var playMouseSounds

    if(is_mousesounds){
      playMouseSounds = true
      mouse_volume_value.classList.remove('hidden');
      mouse_volume.classList.remove('hidden');
      mousepack_list.classList.remove('hidden');
      mouseslider.classList.remove('hidden');
      mouseNotification.classList.add('hidden');
    }

    ipcRenderer.on('MouseSounds', function (_event, _is_mousesounds) {
      is_mousesounds = _is_mousesounds;
      if (is_mousesounds) {
        playMouseSounds = true
        mouse_volume_value.classList.remove('hidden');
        mouse_volume.classList.remove('hidden');
        mousepack_list.classList.remove('hidden');
        mouseslider.classList.remove('hidden');
        mouseNotification.classList.add('hidden');
      } else {
        playMouseSounds = false
        pressedMouseButtons.clear();
        mouseslider.classList.add('hidden');
        mousepack_list.classList.add('hidden');
        mouse_volume_value.classList.add('hidden');
        mouse_volume.classList.add('hidden');
        mouseNotification.classList.remove('hidden');
      }
    });

    //Random Sounds
    var randomSounds
    
    if(is_random){
      randomSounds = true
    }

    ipcRenderer.on('RandomSoundEnable', function (_event, _is_random) {
      is_random = _is_random;
      if (is_random) {
        randomSounds = true
      } else {
        randomSounds = false
      }
    });

    ipcRenderer.on('input:mousedown', (_event, { button }) => {
      if(playMouseSounds){
        if (pressedMouseButtons.has(button)) {
          return;
        }

        pressedMouseButtons.add(button);
        const sound_id = `${button}`;

        if (current_mouse_pack) {
          playMouseSound(`${sound_id}`, mouseVolume, 'down')
        }
      }
    })

    ipcRenderer.on('input:mouseup', (_event, { button } = {}) => {
      const mouseButton = button != null ? button : pressedMouseButtons.values().next().value;
      pressedMouseButtons.delete(mouseButton);
      if(playMouseSounds && mouseButton != null){
        playMouseSound(`${mouseButton}`, mouseVolume, 'up')
      }
    })



    const keyPressedSet = new Set();


    // if key released, clear current key
    ipcRenderer.on('input:keyup', (_event, { keycode }) => {
      if(playKeyupSound){
        playSound(`${keycode}`, keyboardVolume, playKeyupSound, 'up');
      }
      keyPressedSet.delete(keycode);
      if(keyPressedSet.size < 1){
        app_logo.classList.remove('pressed');
      }
    });

    // key pressed, pack current key and play sound
    ipcRenderer.on('input:keydown', (_event, { keycode }) => {
      // if hold down a key, not repeat the sound
      if (keyPressedSet.has(keycode)) {
        return;
      }

      // display current pressed key
      // app_logo.innerHTML = keycode;
      app_logo.classList.add('pressed');

      const applicablekeys = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83]
      const nonapplicablekeys = [57, 29, 3613, 42, 54, 58, 28, 15, 14, 56, 3640]

      keyPressedSet.add(keycode);

      // pack current pressed key
      if(randomSounds && !nonapplicablekeys.includes(keycode)){
        current_sound_key = applicablekeys[Math.floor(Math.random() * applicablekeys.length)];
      }
      else{
        current_sound_key = keycode;
      }


      var sound_id = `${current_sound_key}`;

      // get loaded audio object
      // if object valid, pack volume and play sound
      if (current_keyboard_pack) {
        if(playKeyupSound){
          playSound(`${current_sound_key}`, keyboardVolume, playKeyupSound, 'down');
        }
        else{
          playSound(sound_id, keyboardVolume, playKeyupSound, 'null');
        }
      }
    });
  });
})(window, document);

// ==================================================
// universal play function
function playSound(sound_id, volume, playKeyupSound, downOrUp) {
  if (!current_keyboard_pack) {
    return;
  }

  const pack_compatibility = current_keyboard_pack.compatibility ? current_keyboard_pack.compatibility : false;
  var keycode = `keycode-${sound_id}`;


      //!Setting keycode correct for compat packs!
      if(playKeyupSound && downOrUp == 'down' && pack_compatibility){
        keycode = `keycode-0${sound_id}`
      }
      else if(playKeyupSound && downOrUp == 'up' && pack_compatibility){
        keycode = `keycode-00${sound_id}`
      }

  const play_type = current_keyboard_pack.key_define_type ? current_keyboard_pack.key_define_type : 'single';
  const sound = play_type == 'single' ? current_keyboard_pack.sound : current_keyboard_pack.sound[keycode];
  if (!sound) {
    return;
  }

  let spriteId = play_type == 'single' ? keycode : null;
  if (playKeyupSound && !pack_compatibility && (downOrUp == 'down' || downOrUp == 'up')) {
    spriteId = getSplitSpriteId(sound, play_type == 'single' ? keycode : '__default', downOrUp);
  }

  if (play_type == 'single' && (!sound._sprite || !sound._sprite[spriteId])) {
    return;
  }

  const limiterKey = `keyboard:${current_keyboard_pack.pack_id}:${keycode}:${downOrUp || 'tap'}`;
  if (!canStartKeyboardSound(limiterKey, MIN_KEY_SOUND_INTERVAL_MS)) {
    return;
  }

  sound.volume(volumeToHowler(volume, DEFAULT_KEYBOARD_VOLUME));
  if (play_type == 'single') {
    playHowlLimited(sound, spriteId, MAX_ACTIVE_PER_SINGLE_HOWL);
  } else {
    playHowlLimited(sound, spriteId, MAX_ACTIVE_PER_MULTI_HOWL);
  }
}

function playMouseSound(mouseCode, volume, downOrUp){
  if (!current_mouse_pack) {
    return;
  }

  var keycode = `keycode-${mouseCode}`;

  if(downOrUp == 'down'){
    keycode = `keycode-${mouseCode}`;
  }
  else if(downOrUp == 'up'){
    keycode = `keycode-0${mouseCode}`;
  }

  const play_type = current_mouse_pack.key_define_type ? current_mouse_pack.key_define_type : 'single';
  const sound = play_type == 'single' ? current_mouse_pack.sound : current_mouse_pack.sound[keycode];
  if (!sound) {
    return;
  }

  if (play_type == 'single' && (!sound._sprite || !sound._sprite[keycode])) {
    return;
  }

  const limiterKey = `mouse:${current_mouse_pack.pack_id}:${mouseCode}`;
  if (!canStartMouseSound(limiterKey, MIN_MOUSE_SOUND_INTERVAL_MS)) {
    return;
  }

  sound.volume(volumeToHowler(volume, DEFAULT_MOUSE_VOLUME));
  if (play_type == 'single') {
    playHowlLimited(sound, keycode, MAX_ACTIVE_MOUSE_SINGLE_HOWL);
  } else {
    playHowlLimited(sound, null, MAX_ACTIVE_MOUSE_MULTI_HOWL);
  }
}

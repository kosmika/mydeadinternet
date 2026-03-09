(function () {
  const THREE_URL = 'https://unpkg.com/three@0.160.0/build/three.min.js';
  const MAX_WELLS = 24;
  const MAX_TRAIL_POINTS = 7;

  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    if (window.__worlds3dThreePromise) return window.__worlds3dThreePromise;
    window.__worlds3dThreePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = THREE_URL;
      s.async = true;
      s.onload = () => resolve(window.THREE);
      s.onerror = () => reject(new Error('Failed to load three.js'));
      document.head.appendChild(s);
    });
    return window.__worlds3dThreePromise;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  class Worlds3DEngine {
    constructor(containerId) {
      this.containerId = containerId;
      this.el = null;
      this.THREE = null;
      this.scene = null;
      this.camera = null;
      this.renderer = null;

      this.wellField = null;
      this.gridOverlay = null;
      this.instanced = null;
      this.linkAlliances = null;
      this.linkConflicts = null;
      this.trails = null;
      this.missionBeacons = null;
      this.eventImpacts = null;
      this.fragmentFlows = null;
      this.fragmentAnchors = null;

      this.maxInstances = 700;
      this.maxMissionBeacons = 64;
      this.ready = false;
      this.booting = false;
      this.focus = { x: 0, z: 0 };
      this.hasTrackedFocus = false;
      this.agentPositions = new Map();
      this.trailMap = new Map();
      this.lastScanEventAt = '';
      this.raf = null;
      this.resizeObs = null;
      this.dummy = null;

      this.palette = {
        bg: 0x03060d,
        neutral: '#dbe9ff',
        tracked: '#7ee8ff',
        alliance: '#31d39a',
        conflict: '#ff6f91',
        mission: '#fbbf24'
      };

      this.uniforms = {
        uTime: { value: 0 },
        uPulseTime: { value: -1000 },
        uPulseCenter: { value: null },
        uAgentCount: { value: 0 },
        uAgents: { value: [] }
      };
    }

    async init() {
      if (this.ready || this.booting) return;
      this.booting = true;
      this.el = document.getElementById(this.containerId);
      if (!this.el) {
        this.booting = false;
        return;
      }
      try {
        this.THREE = await loadThree();
        const THREE = this.THREE;

        this.uniforms.uPulseCenter.value = new THREE.Vector2(0, 0);
        this.uniforms.uAgents.value = Array.from({ length: MAX_WELLS }, () => new THREE.Vector3(9999, 0, 9999));

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(this.palette.bg);
        this.scene.fog = new THREE.Fog(0x02050a, 30, 95);

        this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1200);
        this.camera.position.set(0, 24, 26);
        this.camera.lookAt(0, 0, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setSize(this.el.clientWidth || 960, this.el.clientHeight || 960, false);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.el.innerHTML = '';
        this.el.appendChild(this.renderer.domElement);

        const hemi = new THREE.HemisphereLight(0x79c9ff, 0x060a14, 0.85);
        const key = new THREE.DirectionalLight(0x8fa8ff, 0.62);
        key.position.set(10, 28, 12);
        const rim = new THREE.PointLight(0x1dd3ff, 0.5, 120);
        rim.position.set(-12, 8, -10);
        this.scene.add(hemi, key, rim);

        this.buildField();
        this.buildAgents();
        this.buildLinks();
        this.buildTrails();
        this.buildMissions();
        this.buildImpacts();
        this.buildFragments();

        this.dummy = new THREE.Object3D();

        this.resizeObs = new ResizeObserver(() => this.resize());
        this.resizeObs.observe(this.el);
        this.resize();

        this.ready = true;
        this.animate();
      } catch (err) {
        console.error('[worlds-3d] init failed', err);
      } finally {
        this.booting = false;
      }
    }

    buildField() {
      const THREE = this.THREE;
      const fieldGeo = new THREE.PlaneGeometry(86, 86, 140, 140);
      const vertexShader = `
        uniform float uTime;
        uniform float uPulseTime;
        uniform vec2 uPulseCenter;
        uniform int uAgentCount;
        uniform vec3 uAgents[${MAX_WELLS}];
        varying float vGlow;
        varying float vPulse;
        void main() {
          vec3 p = position;
          float sink = 0.0;
          float glow = 0.0;
          for (int i = 0; i < ${MAX_WELLS}; i++) {
            if (i >= uAgentCount) break;
            vec3 a = uAgents[i];
            float d = distance(p.xz, a.xz);
            float well = exp(-d * d * 0.085);
            sink += well * 0.68;
            glow += exp(-d * d * 0.02) * 0.35;
          }

          float pulseAge = max(0.0, uTime - uPulseTime);
          float pulseRadius = pulseAge * 10.0;
          float pd = distance(p.xz, uPulseCenter.xy);
          float ring = exp(-pow((pd - pulseRadius) * 1.3, 2.0));

          p.y -= sink;
          p.y += ring * 0.52;
          vGlow = glow;
          vPulse = ring;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `;
      const fragmentShader = `
        varying float vGlow;
        varying float vPulse;
        void main() {
          vec3 base = vec3(0.03, 0.07, 0.12);
          vec3 aura = vec3(0.07, 0.22, 0.36) * vGlow;
          vec3 pulse = vec3(0.10, 0.66, 0.90) * vPulse;
          vec3 col = base + aura + pulse;
          gl_FragColor = vec4(col, 0.96);
        }
      `;

      const fieldMat = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader,
        fragmentShader,
        transparent: false,
        wireframe: false
      });

      this.wellField = new THREE.Mesh(fieldGeo, fieldMat);
      this.wellField.rotation.x = -Math.PI / 2;
      this.wellField.position.y = -0.05;
      this.scene.add(this.wellField);

      const gridGeo = new THREE.PlaneGeometry(86, 86, 86, 86);
      const gridMat = new THREE.MeshBasicMaterial({ color: 0x1c3f64, wireframe: true, transparent: true, opacity: 0.4 });
      this.gridOverlay = new THREE.Mesh(gridGeo, gridMat);
      this.gridOverlay.rotation.x = -Math.PI / 2;
      this.gridOverlay.position.y = 0.02;
      this.scene.add(this.gridOverlay);
    }

    buildAgents() {
      const THREE = this.THREE;
      const g = new THREE.OctahedronGeometry(0.34, 0);
      const m = new THREE.MeshStandardMaterial({
        color: this.palette.neutral,
        roughness: 0.28,
        metalness: 0.2,
        vertexColors: true,
        emissive: 0x08172a,
        emissiveIntensity: 0.65
      });
      this.instanced = new THREE.InstancedMesh(g, m, this.maxInstances);
      this.instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(this.instanced);
    }

    buildLinks() {
      const THREE = this.THREE;
      this.linkAlliances = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x31d39a, transparent: true, opacity: 0.42 })
      );
      this.linkConflicts = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0xff6f91, transparent: true, opacity: 0.58 })
      );
      this.scene.add(this.linkAlliances, this.linkConflicts);
    }

    buildTrails() {
      const THREE = this.THREE;
      this.trails = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x9ec0ff, transparent: true, opacity: 0.28 })
      );
      this.scene.add(this.trails);
    }

    buildMissions() {
      const THREE = this.THREE;
      const g = new THREE.SphereGeometry(0.16, 10, 10);
      const m = new THREE.MeshStandardMaterial({ color: this.palette.mission, emissive: 0x665100, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.1 });
      this.missionBeacons = new THREE.InstancedMesh(g, m, this.maxMissionBeacons);
      this.missionBeacons.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(this.missionBeacons);
    }

    buildImpacts() {
      const THREE = this.THREE;
      const geom = new THREE.BufferGeometry();
      const mat = new THREE.PointsMaterial({
        size: 0.42,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.9,
        vertexColors: true
      });
      this.eventImpacts = new THREE.Points(geom, mat);
      this.scene.add(this.eventImpacts);
    }

    buildFragments() {
      const THREE = this.THREE;
      this.fragmentFlows = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x5cead1, transparent: true, opacity: 0.34 })
      );
      this.fragmentAnchors = new THREE.Points(
        new THREE.BufferGeometry(),
        new THREE.PointsMaterial({ size: 0.22, transparent: true, opacity: 0.78, color: 0x5cead1 })
      );
      this.scene.add(this.fragmentFlows, this.fragmentAnchors);
    }

    resize() {
      if (!this.ready || !this.el || !this.renderer || !this.camera) return;
      const w = Math.max(this.el.clientWidth || 960, 64);
      const h = Math.max(this.el.clientHeight || 960, 64);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    tileToWorld(x, y, w, h) {
      const ox = (w - 1) / 2;
      const oy = (h - 1) / 2;
      return { x: x - ox, z: y - oy };
    }

    buildEdgeGeometry(edges, w, h) {
      const THREE = this.THREE;
      const verts = [];
      for (const edge of edges) {
        const a = this.agentPositions.get(edge.agent_a);
        const b = this.agentPositions.get(edge.agent_b);
        if (!a || !b) continue;
        const p1 = this.tileToWorld(a.x, a.y, w, h);
        const p2 = this.tileToWorld(b.x, b.y, w, h);
        verts.push(p1.x, 0.15, p1.z, p2.x, 0.15, p2.z);
      }
      return new THREE.Float32BufferAttribute(verts, 3);
    }

    updateLinks(ecology, w, h) {
      if (!this.linkAlliances || !this.linkConflicts) return;
      const alliances = Array.isArray(ecology?.top_alliances) ? ecology.top_alliances.slice(0, 56) : [];
      const conflicts = Array.isArray(ecology?.top_conflicts) ? ecology.top_conflicts.slice(0, 56) : [];

      const aPos = this.buildEdgeGeometry(alliances, w, h);
      const cPos = this.buildEdgeGeometry(conflicts, w, h);
      this.linkAlliances.geometry.setAttribute('position', aPos);
      this.linkConflicts.geometry.setAttribute('position', cPos);
      this.linkAlliances.visible = aPos.count > 0;
      this.linkConflicts.visible = cPos.count > 0;
    }

    pushTrail(name, x, y) {
      const arr = this.trailMap.get(name) || [];
      const last = arr[arr.length - 1];
      if (!last || last.x !== x || last.y !== y) {
        arr.push({ x, y, t: Date.now() });
        if (arr.length > MAX_TRAIL_POINTS) arr.shift();
        this.trailMap.set(name, arr);
      }
    }

    updateTrails(w, h) {
      if (!this.trails) return;
      const THREE = this.THREE;
      const verts = [];
      this.trailMap.forEach((arr) => {
        for (let i = 1; i < arr.length; i += 1) {
          const a = this.tileToWorld(arr[i - 1].x, arr[i - 1].y, w, h);
          const b = this.tileToWorld(arr[i].x, arr[i].y, w, h);
          verts.push(a.x, 0.22, a.z, b.x, 0.22, b.z);
        }
      });
      this.trails.geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      this.trails.visible = verts.length > 0;
    }

    buildTerritoryCenterMap(map) {
      const territoryCenter = new Map();
      if (!map || !Array.isArray(map.tiles)) return territoryCenter;
      const agg = new Map();
      for (const tile of map.tiles) {
        if (!tile.territory_id) continue;
        const s = agg.get(tile.territory_id) || { x: 0, y: 0, n: 0 };
        s.x += tile.x;
        s.y += tile.y;
        s.n += 1;
        agg.set(tile.territory_id, s);
      }
      agg.forEach((v, k) => {
        territoryCenter.set(k, { x: v.x / v.n, y: v.y / v.n });
      });
      return territoryCenter;
    }

    updateMissions(ecology, map, w, h) {
      if (!this.missionBeacons || !map || !Array.isArray(map.tiles)) return;
      const missions = Array.isArray(ecology?.top_missions) ? ecology.top_missions.slice(0, this.maxMissionBeacons) : [];
      const territoryCenter = this.buildTerritoryCenterMap(map);

      for (let i = 0; i < this.maxMissionBeacons; i += 1) {
        if (i < missions.length) {
          const t = missions[i].territory_id;
          const c = territoryCenter.get(t);
          if (c) {
            const p = this.tileToWorld(c.x, c.y, w, h);
            this.dummy.position.set(p.x, 0.45 + ((i % 3) * 0.12), p.z);
            const s = missions[i].mission_type === 'governance_push' ? 1.9 : 1.25;
            this.dummy.scale.set(0.9 * s, 0.9 * s, 0.9 * s);
          } else {
            this.dummy.position.set(9999, -9999, 9999);
            this.dummy.scale.set(0.001, 0.001, 0.001);
          }
        } else {
          this.dummy.position.set(9999, -9999, 9999);
          this.dummy.scale.set(0.001, 0.001, 0.001);
        }
        this.dummy.updateMatrix();
        this.missionBeacons.setMatrixAt(i, this.dummy.matrix);
      }
      this.missionBeacons.instanceMatrix.needsUpdate = true;
    }

    updateFragments(fragmentStream, map, w, h, filters) {
      if (!this.fragmentFlows || !this.fragmentAnchors) return;
      if (!filters || filters.fragments === false) {
        this.fragmentFlows.visible = false;
        this.fragmentAnchors.visible = false;
        return;
      }
      const THREE = this.THREE;
      const fragments = Array.isArray(fragmentStream) ? fragmentStream.slice(0, 120) : [];
      const territoryCenter = this.buildTerritoryCenterMap(map);
      const flowVerts = [];
      const anchorVerts = [];

      for (const f of fragments) {
        const agent = this.agentPositions.get(f.agent_name);
        if (!agent) continue;
        const a = this.tileToWorld(agent.x, agent.y, w, h);
        const terr = f.territory_id && territoryCenter.get(f.territory_id);
        if (!terr) continue;
        const t = this.tileToWorld(terr.x, terr.y, w, h);
        flowVerts.push(a.x, 0.36, a.z, t.x, 0.2, t.z);
        anchorVerts.push(t.x, 0.23, t.z);
      }

      this.fragmentFlows.geometry.setAttribute('position', new THREE.Float32BufferAttribute(flowVerts, 3));
      this.fragmentAnchors.geometry.setAttribute('position', new THREE.Float32BufferAttribute(anchorVerts, 3));
      this.fragmentFlows.visible = flowVerts.length > 0;
      this.fragmentAnchors.visible = anchorVerts.length > 0;
    }

    updatePulse(world, w, h) {
      if (!world || !Array.isArray(world.recent_events)) return;
      const scans = world.recent_events.filter((e) => e && e.event_type === 'scan');
      if (!scans.length) return;
      const latest = scans[0];
      if (!latest.created_at || latest.created_at === this.lastScanEventAt) return;
      this.lastScanEventAt = latest.created_at;
      if (!latest.actor_name) return;
      const pos = this.agentPositions.get(latest.actor_name);
      if (!pos) return;
      const p = this.tileToWorld(pos.x, pos.y, w, h);
      this.uniforms.uPulseCenter.value.set(p.x, p.z);
      this.uniforms.uPulseTime.value = this.uniforms.uTime.value;
    }

    updateImpacts(world, w, h, filters) {
      if (!this.eventImpacts || !world) return;
      const THREE = this.THREE;
      const positions = [];
      const colors = [];
      const f = Object.assign({ collisions: true, debates: true, dreams: true, gifts: true, fragments: true }, filters || {});

      // Collision hotspots where multiple agents converge on one tile.
      const occ = Array.isArray(world.occupants) ? world.occupants : [];
      if (f.collisions) {
        const byTile = new Map();
        for (const a of occ) {
          const key = `${a.x},${a.y}`;
          const slot = byTile.get(key) || { x: a.x, y: a.y, c: 0 };
          slot.c += 1;
          byTile.set(key, slot);
        }
        byTile.forEach((slot) => {
          if (slot.c < 2) return;
          const p = this.tileToWorld(slot.x, slot.y, w, h);
          positions.push(p.x, 0.32 + (slot.c * 0.03), p.z);
          const t = clamp((slot.c - 1) / 5, 0, 1);
          colors.push(1.0, 0.5 + (0.4 * (1 - t)), 0.15);
        });
      }

      // Debate/gift/fragment/dream events create impact intersections.
      const rec = Array.isArray(world.recent_events) ? world.recent_events.slice(0, 60) : [];
      for (const e of rec) {
        const t = String(e.event_type || '').toLowerCase();
        const isDebate = t.includes('debate');
        const isDream = t.includes('dream');
        const isGift = t.includes('gift');
        const isFragment = t.includes('fragment') || t.includes('gather');
        if ((isDebate && !f.debates) || (isDream && !f.dreams) || (isGift && !f.gifts) || (isFragment && !f.fragments)) continue;
        if (!isDebate && !isDream && !isGift && !isFragment) continue;
        if (!e.actor_name) continue;
        const actor = this.agentPositions.get(e.actor_name);
        if (!actor) continue;
        const p = this.tileToWorld(actor.x, actor.y, w, h);
        positions.push(p.x, 0.52, p.z);
        if (t.includes('debate')) colors.push(1.0, 0.35, 0.55);
        else if (t.includes('dream')) colors.push(0.62, 0.55, 1.0);
        else if (t.includes('gift')) colors.push(1.0, 0.88, 0.22);
        else if (t.includes('fragment')) colors.push(0.30, 0.95, 0.78);
        else colors.push(0.52, 0.84, 1.0);
      }

      this.eventImpacts.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      this.eventImpacts.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      this.eventImpacts.visible = positions.length > 0;
      this.eventImpacts.material.size = 0.34 + (0.08 * Math.sin(this.uniforms.uTime.value * 4.2));
    }

    update(payload) {
      if (!payload) return;
      this.init();
      if (!this.ready || !this.instanced) return;

      const map = payload.map;
      const world = payload.world;
      const ecology = payload.ecology;
      if (!map || !Array.isArray(map.tiles) || !world || !Array.isArray(world.occupants)) return;

      const maxX = Math.max.apply(null, map.tiles.map((t) => t.x));
      const maxY = Math.max.apply(null, map.tiles.map((t) => t.y));
      const w = maxX + 1;
      const h = maxY + 1;

      const occupants = world.occupants;
      const THREE = this.THREE;
      this.agentPositions.clear();
      this.hasTrackedFocus = false;

      const agentCount = Math.min(occupants.length, MAX_WELLS);
      this.uniforms.uAgentCount.value = agentCount;

      for (let i = 0; i < this.maxInstances; i += 1) {
        if (i < occupants.length) {
          const a = occupants[i];
          this.agentPositions.set(a.agent_name, { x: a.x, y: a.y });
          this.pushTrail(a.agent_name, a.x, a.y);

          const p = this.tileToWorld(a.x, a.y, w, h);
          const tracked = payload.trackedAgent && a.agent_name === payload.trackedAgent;
          this.dummy.position.set(p.x, tracked ? 0.7 : 0.42, p.z);
          this.dummy.rotation.set(0, (i * 0.21) % (Math.PI * 2), tracked ? 0.44 : 0.18);
          const sparseBoost = occupants.length < 24 ? 1.25 : 1.0;
          const s = tracked ? 1.72 : (0.9 * sparseBoost);
          this.dummy.scale.set(s, tracked ? 2.1 : 1.34, s);
          this.dummy.updateMatrix();
          this.instanced.setMatrixAt(i, this.dummy.matrix);

          const color = new THREE.Color(tracked ? this.palette.tracked : this.palette.neutral);
          this.instanced.setColorAt(i, color);

          if (i < MAX_WELLS) {
            this.uniforms.uAgents.value[i].set(p.x, 0, p.z);
          }

          if (tracked && payload.focusMode) {
            this.hasTrackedFocus = true;
            this.focus.x = p.x;
            this.focus.z = p.z;
          }
        } else {
          this.dummy.position.set(9999, -9999, 9999);
          this.dummy.scale.set(0.001, 0.001, 0.001);
          this.dummy.updateMatrix();
          this.instanced.setMatrixAt(i, this.dummy.matrix);
        }
      }

      for (let i = agentCount; i < MAX_WELLS; i += 1) {
        this.uniforms.uAgents.value[i].set(9999, 0, 9999);
      }

      this.instanced.instanceMatrix.needsUpdate = true;
      if (this.instanced.instanceColor) this.instanced.instanceColor.needsUpdate = true;

      this.updateLinks(ecology, w, h);
      this.updateTrails(w, h);
      this.updateMissions(ecology, map, w, h);
      this.updateFragments(payload.fragmentStream, map, w, h, payload.impactFilters);
      this.updatePulse(world, w, h);
      this.updateImpacts(world, w, h, payload.impactFilters);

      if (this.gridOverlay) {
        const pulsing = Math.max(0, 1 - (this.uniforms.uTime.value - this.uniforms.uPulseTime.value) * 1.7);
        this.gridOverlay.material.opacity = clamp(0.33 + (pulsing * 0.3), 0.2, 0.68);
      }
    }

    animate() {
      if (!this.ready || !this.renderer || !this.scene || !this.camera) return;
      this.uniforms.uTime.value += 0.016;

      const tx = this.focus.x;
      const tz = this.focus.z;
      const targetY = this.hasTrackedFocus ? 13.8 : 24;
      const targetZ = this.hasTrackedFocus ? (tz + 13.5) : (tz + 26);
      this.camera.position.x += (tx - this.camera.position.x) * 0.14;
      this.camera.position.z += (targetZ - this.camera.position.z) * 0.13;
      this.camera.position.y += ((targetY + (Math.sin(this.uniforms.uTime.value * 0.15) * 0.45)) - this.camera.position.y) * 0.09;
      this.camera.lookAt(tx, this.hasTrackedFocus ? -0.25 : -0.8, tz);

      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(() => this.animate());
    }
  }

  window.Worlds3D = {
    create(containerId) {
      return new Worlds3DEngine(containerId);
    }
  };
})();

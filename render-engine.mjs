export { computeCoverTransform, renderer, scene3d }; 
 
import {ui} from "./ui.mjs";

import * as THREE from "three";
    import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
    import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";


    //renderer setup
   const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    //renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    //renderer.outputColorSpace = THREE.NoColorSpace;
    renderer.physicallyCorrectLights = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15; // will be driven by UI in loop


    //stuff regarding the actual render scene is put here

    const scene3d = new THREE.Scene();

   




    // render functions





       // Map normalized screen UVs to the source image UVs produced by CSS object-fit: cover.
    function computeCoverTransform(screenW, screenH, imageW, imageH) {
      const rs = screenW / screenH;
      const ri = imageW / imageH;
      let scaleX = 1, scaleY = 1, offX = 0, offY = 0;
      if (ri > rs) {
        scaleX = rs / ri;
        offX = (1 - scaleX) * 0.5;
      } else {
        scaleY = ri / rs;
        offY = (1 - scaleY) * 0.5;
      }
      return { scaleX, scaleY, offX, offY };
    }

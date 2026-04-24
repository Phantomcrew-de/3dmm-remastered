import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import environmentColorUrl from '../../old/background.jpg'
import environmentDepthUrl from '../../old/depth.png'
import modelUrl from '../../old/gregory.animation.glb'

const scene = new THREE.Scene()

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 8)
camera.position.set(0, 0.6, 2.6)

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(window.devicePixelRatio)
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setAnimationLoop(animate)
document.body.appendChild(renderer.domElement)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.target.set(0, 0.55, 0)

const ambientLight = new THREE.HemisphereLight(0xffffff, 0x403020, 2.5)
scene.add(ambientLight)

const keyLight = new THREE.DirectionalLight(0xffffff, 2.25)
keyLight.position.set(2, 4, 3)
scene.add(keyLight)

const textureLoader = new THREE.TextureLoader()
const colorMap = textureLoader.load(environmentColorUrl, updateEnvironmentAspect)
colorMap.colorSpace = THREE.SRGBColorSpace
colorMap.minFilter = THREE.LinearFilter
colorMap.magFilter = THREE.LinearFilter

const depthMap = textureLoader.load(environmentDepthUrl, updateEnvironmentAspect)
depthMap.colorSpace = THREE.NoColorSpace
depthMap.minFilter = THREE.LinearFilter
depthMap.magFilter = THREE.LinearFilter

const environmentMaterial = new THREE.ShaderMaterial({
    uniforms: {
        colorMap: { value: colorMap },
        depthMap: { value: depthMap },
        cameraNear: { value: camera.near },
        cameraFar: { value: camera.far },
        imageAspect: { value: 1 },
        viewportAspect: { value: camera.aspect },
    },
    vertexShader: /* glsl */ `
        varying vec2 vUv;

        void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        #include <packing>

        uniform sampler2D colorMap;
        uniform sampler2D depthMap;
        uniform float cameraNear;
        uniform float cameraFar;
        uniform float imageAspect;
        uniform float viewportAspect;

        varying vec2 vUv;

        vec2 coverUv(vec2 uv) {
            vec2 coveredUv = uv - 0.5;

            if (viewportAspect > imageAspect) {
                coveredUv.y *= viewportAspect / imageAspect;
            } else {
                coveredUv.x *= imageAspect / viewportAspect;
            }

            return coveredUv + 0.5;
        }

        void main() {
            vec2 sampleUv = coverUv(vUv);
            vec4 color = texture2D(colorMap, sampleUv);
            float depthSample = texture2D(depthMap, sampleUv).r;
            float viewZ = -mix(cameraFar, cameraNear, depthSample);

            gl_FragColor = color;
            gl_FragDepth = viewZToPerspectiveDepth(viewZ, cameraNear, cameraFar);
        }
    `,
    depthTest: true,
    depthFunc: THREE.AlwaysDepth,
    depthWrite: true,
})

const environment = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), environmentMaterial)
environment.frustumCulled = false
environment.renderOrder = -1
scene.add(environment)

new GLTFLoader().load(modelUrl, (gltf) => {
    const model = gltf.scene
    centerAndScaleModel(model, 1.45)
    model.position.z = -0.8
    scene.add(model)
})

window.addEventListener('resize', onWindowResize, false)

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()

    renderer.setSize(window.innerWidth, window.innerHeight)
    updateDepthUniforms()
}

function updateDepthUniforms() {
    environmentMaterial.uniforms.cameraNear.value = camera.near
    environmentMaterial.uniforms.cameraFar.value = camera.far
    environmentMaterial.uniforms.viewportAspect.value = camera.aspect
}

function updateEnvironmentAspect() {
    const image = colorMap.image as HTMLImageElement | undefined

    if (image?.width && image.height) {
        environmentMaterial.uniforms.imageAspect.value = image.width / image.height
    }
}

function centerAndScaleModel(model: THREE.Object3D, targetSize: number) {
    const box = new THREE.Box3().setFromObject(model)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const largestAxis = Math.max(size.x, size.y, size.z)

    if (largestAxis > 0) {
        const scale = targetSize / largestAxis
        model.scale.setScalar(scale)
        model.position.copy(center).multiplyScalar(-scale)
    }
}

function animate() {
    controls.update()
    renderer.render(scene, camera)
}

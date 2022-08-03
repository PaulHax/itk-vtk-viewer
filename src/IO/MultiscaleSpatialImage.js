import { mat4, vec3 } from 'gl-matrix'
import { setMatrixElement } from 'itk-wasm'
import vtkBoundingBox from 'vtk.js/Sources/Common/DataModel/BoundingBox'

import componentTypeToTypedArray from './componentTypeToTypedArray'

import WebworkerPromise from 'webworker-promise'
import ImageDataFromChunksWorker from './ImageDataFromChunks.worker'
import { chunkArray, CXYZT, ensuredDims } from './dimensionUtils'
import { getDtype } from './dtypeUtils'

const imageDataFromChunksWorker = new ImageDataFromChunksWorker()
const imageDataFromChunksWorkerPromise = new WebworkerPromise(
  imageDataFromChunksWorker
)

// const haveSharedArrayBuffer = typeof window.SharedArrayBuffer === 'function'

/* Every element corresponds to a pyramid scale
     Lower scales, corresponds to a higher index, correspond to a lower
     resolution. 

  scaleInfo = [{
    // scale 0 information
    dims: ['x', 'y'], // Valid elements: 'c', 'x', 'y', 'z', or 't'
    coords: .get() Promise resolves a Map('x': Float64Array([0.0, 2.0, ...), 'y' ...
    chunkCount: Map('t': 1, 'c': 1, 'z': 10, 'y': 10, 'x': 10]), // array shape in chunks
    chunkSize: Map('t': 1, 'c': 1, 'z': 1, 'y': 64, 'x': 64]), // chunk shape in elements
    arrayShape: Map('t': 1, 'c': 1, 'z': 1, 'y': 64, 'x': 64]), // array shape in elements
    ranges: Map('1': [0, 140], '2': [3, 130]) // or null if unknown. Range of values for each component
    name: 'dataset_name'
  },
  { scale 1 information },
  { scale N information }
  ]
*/

const ensure3dDirection = d => {
  if (d.length === 9) {
    return d
  }
  // Pad 2D with Z dimension
  return [d[0], d[1], 0, d[2], d[3], 0, 0, 0, 1]
}

const makeMat4 = ({ direction, origin, spacing }) => {
  const mat = []
  mat4.fromTranslation(mat, origin)

  mat[0] = direction[0]
  mat[1] = direction[1]
  mat[2] = direction[2]
  mat[4] = direction[3]
  mat[5] = direction[4]
  mat[6] = direction[5]
  mat[8] = direction[6]
  mat[9] = direction[7]
  mat[10] = direction[8]

  return mat4.scale(mat, mat, spacing) // index to world here
}

const makeIndexToWorld = ({ direction: inDirection, origin, spacing }) => {
  const DIMENSIONS = 3
  const direction = [...inDirection]
  for (let idx = 0; idx < DIMENSIONS; ++idx) {
    for (let col = 0; col < DIMENSIONS; ++col) {
      // ITK (and VTKMath) uses row-major index axis, but gl-matrix uses column-major. Transpose.
      direction[col + idx * 3] = direction[idx + col * DIMENSIONS]
    }
  }

  if (origin[2] === undefined) origin[2] = 0
  if (spacing[2] === undefined) spacing[2] = 1
  return makeMat4({ direction, origin, spacing })
}

const worldBoundsToIndexBounds = ({ bounds, arrayShape, worldToIndex }) => {
  if (!bounds || bounds.length === 0) {
    return new Map(
      Array.from(arrayShape).map(([dim, size]) => [dim, [0, size]])
    )
  }

  const imageBounds = [...vtkBoundingBox.INIT_BOUNDS]
  vtkBoundingBox
    .getCorners(bounds, [])
    .map(corner => vec3.transformMat4(corner, corner, worldToIndex))
    .forEach(corner => {
      vtkBoundingBox.addPoint(imageBounds, ...corner)
    })

  const imageBoundsByDim = chunkArray(2, imageBounds)
  const spaceBounds = ['x', 'y', 'z'].map((dim, idx) => {
    const [min, max] = [0, arrayShape.get(dim) ?? 1]
    const [bmin, bmax] = imageBoundsByDim[idx]
    return [
      dim,
      [
        Math.floor(Math.min(max, Math.max(min, bmin))),
        Math.ceil(Math.min(max, Math.max(min, bmax))),
      ],
    ]
  })
  const ctBounds = ['c', 't'].map(dim => [dim, [0, arrayShape.get(dim) ?? 1]])

  return new Map([...spaceBounds, ...ctBounds])
}

class MultiscaleSpatialImage {
  scaleInfo = []
  name = 'Image'

  constructor(scaleInfo, imageType, name = 'Image') {
    this.scaleInfo = scaleInfo
    this.name = name

    this.imageType = imageType
    this.pixelArrayType = componentTypeToTypedArray.get(imageType.componentType)
    this.spatialDims = ['x', 'y', 'z'].slice(0, imageType.dimension)
    this.cachedScaleLargestImage = new Map()
  }

  get lowestScale() {
    return this.scaleInfo.length - 1
  }

  async scaleOrigin(scale) {
    const origin = new Array(this.spatialDims.length)
    const info = this.scaleInfo[scale]
    for (let index = 0; index < this.spatialDims.length; index++) {
      const dim = this.spatialDims[index]
      if (info.coords.has(dim)) {
        const coords = await info.coords.get(dim)
        origin[index] = coords[0]
      } else {
        origin[index] = 0.0
      }
    }
    return origin
  }

  async scaleSpacing(scale) {
    const spacing = new Array(this.spatialDims.length)
    const info = this.scaleInfo[scale]
    for (let index = 0; index < this.spatialDims.length; index++) {
      const dim = this.spatialDims[index]
      if (info.coords.has(dim)) {
        const coords = await info.coords.get(dim)
        spacing[index] = coords[1] - coords[0]
      } else {
        spacing[index] = 1.0
      }
    }
    return spacing
  }

  get direction() {
    const dimension = this.imageType.dimension
    const direction = new Float64Array(dimension * dimension)
    // Direction should be consistent over scales
    const infoDirection = this.scaleInfo[0].direction
    if (infoDirection) {
      // Todo: verify this logic
      const dims = this.scaleInfo[0].dims
      for (let d1 = 0; d1 < dimension; d1++) {
        const sd1 = this.spatialDims[d1]
        const di1 = dims.indexOf(sd1)
        for (let d2 = 0; d2 < dimension; d2++) {
          const sd2 = this.spatialDims[d2]
          const di2 = dims.indexOf(sd2)
          setMatrixElement(
            direction,
            dimension,
            d1,
            d2,
            infoDirection[di1][di2]
          )
        }
      }
    } else {
      direction.fill(0.0)
      for (let d = 0; d < dimension; d++) {
        setMatrixElement(direction, dimension, d, d, 1.0)
      }
    }
    return direction
  }

  /* Return a promise that provides the requested chunk at a given scale and
   * chunk index. */
  async getChunks(scale, cxyztArray) {
    return this.getChunksImpl(scale, cxyztArray)
  }

  async getChunksImpl(/* scale, cxyztArray */) {
    console.error('Override me in a derived class')
  }

  async buildImage(scale, bounds) {
    const info = this.scaleInfo[scale]

    // cache for getItkImageMeta
    if (!info.origin) info.origin = await this.scaleOrigin(scale)
    if (!info.spacing) info.spacing = await this.scaleSpacing(scale)

    const { spacing, origin: fullImageOrigin } = info
    const direction = ensure3dDirection(this.direction)
    const indexToWorld = makeIndexToWorld({
      direction,
      origin: fullImageOrigin,
      spacing,
    })
    const indexBounds = worldBoundsToIndexBounds({
      bounds,
      arrayShape: info.arrayShape,
      worldToIndex: mat4.invert([], indexToWorld),
    })

    const start = new Map(
      CXYZT.map(dim => [dim, indexBounds.get(dim)?.[0] ?? 0])
    )
    const end = new Map(CXYZT.map(dim => [dim, indexBounds.get(dim)?.[1] ?? 1]))

    const arrayShape = new Map(
      CXYZT.map(dim => [dim, end.get(dim) - start.get(dim)])
    )

    const startXYZ = ['x', 'y', 'z'].map(dim => start.get(dim))
    const origin = vec3.transformMat4([], startXYZ, indexToWorld)

    const chunkSize = ensuredDims(1, CXYZT, info.chunkSize)
    const l = 0
    const zChunkStart = Math.floor(start.get('z') / chunkSize.get('z'))
    const zChunkEnd = Math.ceil(end.get('z') / chunkSize.get('z'))
    const yChunkStart = Math.floor(start.get('y') / chunkSize.get('y'))
    const yChunkEnd = Math.ceil(end.get('y') / chunkSize.get('y'))
    const xChunkStart = Math.floor(start.get('x') / chunkSize.get('x'))
    const xChunkEnd = Math.ceil(end.get('x') / chunkSize.get('x'))
    const cChunkStart = 0
    const cChunkEnd = info.chunkCount.get('c') ?? 1

    const chunkIndices = []
    for (let k = zChunkStart; k < zChunkEnd; k++) {
      for (let j = yChunkStart; j < yChunkEnd; j++) {
        for (let i = xChunkStart; i < xChunkEnd; i++) {
          for (let h = cChunkStart; h < cChunkEnd; h++) {
            chunkIndices.push([h, i, j, k, l])
          } // for every cChunk
        } // for every xChunk
      } // for every yChunk
    } // for every zChunk

    const chunks = await this.getChunks(scale, chunkIndices)

    // const transferables = chunks.filter(
    //   buffer =>
    //     // transferables cannot have SharedArrayBuffers
    //     !haveSharedArrayBuffer || !(buffer instanceof SharedArrayBuffer)
    // )

    const args = {
      scaleInfo: {
        chunkSize: info.chunkSize,
        arrayShape: arrayShape,
        dtype: info.pixelArrayMetadata?.dtype ?? getDtype(this.pixelArrayType),
      },
      imageType: this.imageType,
      chunkIndices,
      chunks,
      indexStart: start,
      indexEnd: end,
    }
    const pixelArray = await imageDataFromChunksWorkerPromise.exec(
      'imageDataFromChunks',
      args
      // transferables
    )

    return {
      imageType: this.imageType,
      name: this.scaleInfo[scale].name,
      origin,
      spacing,
      direction: this.direction,
      size: ['x', 'y', 'z']
        .slice(0, this.imageType.dimension)
        .map(dim => arrayShape.get(dim)),
      data: pixelArray,
    }
  }

  /* Retrieve bounded image at scale. */
  async getImage(scale, bounds = []) {
    const imageKey = `${scale}_${bounds.join()}`
    if (this.cachedScaleLargestImage.has(imageKey)) {
      return this.cachedScaleLargestImage.get(imageKey)
    }
    const image = await this.buildImage(scale, bounds)
    this.cachedScaleLargestImage.set(imageKey, image)
    return image
  }

  // origin and spacing will be undefined if buildImage() not completed on scale first
  getItkImageMeta(scale) {
    const { name, origin, spacing, arrayShape } = this.scaleInfo[scale]
    return {
      imageType: this.imageType,
      name,
      origin,
      spacing,
      direction: this.direction,
      size: this.spatialDims.map(dim => arrayShape.get(dim)),
      data: [],
    }
  }
}

export default MultiscaleSpatialImage

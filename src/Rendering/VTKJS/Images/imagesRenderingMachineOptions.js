import createImageRenderer from './createImageRenderer'
import toggleLayerVisibility from './toggleLayerVisibility'
import applyComponentVisibility from './applyComponentVisibility'
import updateRenderedImage, {
  computeRenderedBounds,
} from './updateRenderedImage'
import updateHistogram from './updateHistogram'
import selectImageLayer from './selectImageLayer'
import toggleInterpolation from './toggleInterpolation'
import applyColorRange from './applyColorRange'
import applyColorMap from './applyColorMap'
import applyRenderedImage from './applyRenderedImage'
import applyPiecewiseFunction from './applyPiecewiseFunction'
import applyShadow from './applyShadow'
import applyGradientOpacity from './applyGradientOpacity'
import applyVolumeSampleDistance from './applyVolumeSampleDistance'
import applyBlendMode from './applyBlendMode'
import applyLookupTable from './applyLookupTable'
import applyLabelImageBlend from './applyLabelImageBlend'
import applyLabelNames from './applyLabelNames'
import applyLabelImageWeights from './applyLabelImageWeights'
import applySelectedLabel from './applySelectedLabel'
import { getBoundsOfFullImage } from '../Main/croppingPlanes'

const imagesRenderingMachineOptions = {
  imageRenderingActor: {
    services: {
      createImageRenderer,
      updateRenderedImage,
      updateHistogram,
    },

    actions: {
      applyRenderedImage,

      toggleLayerVisibility,

      toggleInterpolation,

      applyComponentVisibility,

      applyPiecewiseFunction,

      applyColorRange,

      applyColorMap,

      applyShadow,

      applyGradientOpacity,

      applyVolumeSampleDistance,

      applyBlendMode,

      applyLookupTable,
      applyLabelImageBlend,
      applyLabelNames,
      applyLabelImageWeights,
      applySelectedLabel,
      updateIsFramerateScalePickingOn: ({ images }, event) => {
        images.actorContext.get(
          images.updateRenderedName
        ).isFramerateScalePickingOn = event.type !== 'SET_IMAGE_SCALE'
      },
    },

    guards: {
      isFramerateScalePickingOn: ({ images }) =>
        images.actorContext.get(images.updateRenderedName)
          .isFramerateScalePickingOn,

      areBoundsBigger: context => {
        const {
          images: { actorContext, updateRenderedName },
        } = context
        const { loadedBounds } = actorContext.get(updateRenderedName)

        const currentBounds = computeRenderedBounds(context)
        const maxImageBounds = getBoundsOfFullImage(context)
        currentBounds.forEach((b, i) => {
          if (i % 2) {
            currentBounds[i] = Math.min(b, maxImageBounds[i])
          } else {
            currentBounds[i] = Math.max(b, maxImageBounds[i])
          }
        })
        return (
          loadedBounds[0] > currentBounds[0] ||
          loadedBounds[1] < currentBounds[1] ||
          loadedBounds[2] > currentBounds[2] ||
          loadedBounds[3] < currentBounds[3] ||
          loadedBounds[4] > currentBounds[4] ||
          loadedBounds[5] < currentBounds[5]
        )
      },
    },
  },

  actions: {
    selectImageLayer,
  },
}

export default imagesRenderingMachineOptions

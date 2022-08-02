import { Machine, assign } from 'xstate'

const assignUpdateRenderedName = assign({
  images: (context, event) => {
    const images = context.images
    images.updateRenderedName = event.data.name
    return images
  },
})

const assignUpdateRenderedNameToSelectedName = assign({
  images: context => {
    const images = context.images
    images.updateRenderedName = images.selectedName
    return images
  },
})

const assignHigherScale = assign({
  images: context => {
    const images = context.images
    const actorContext = images.actorContext.get(images.updateRenderedName)
    actorContext.renderedScale--
    return images
  },
})

const assignLowerScale = assign({
  images: context => {
    const images = context.images
    const actorContext = images.actorContext.get(images.updateRenderedName)
    let lowestScale = 0
    if (actorContext.image) {
      lowestScale = actorContext.image.lowestScale
    } else if (actorContext.labelImage) {
      lowestScale = actorContext.labelImage.lowestScale
    }
    if (actorContext.renderedScale < lowestScale) {
      actorContext.renderedScale++
    }
    return images
  },
})

const assignRenderedScale = assign({
  images: ({ images }, { renderedScale }) => {
    const actorContext = images.actorContext.get(images.updateRenderedName)
    actorContext.renderedScale = renderedScale
    return images
  },
})

const RENDERED_VOXEL_MAX = 512 * 512 * 512

// Return true if highest scale or right scale (to stop loading of higher scale)
function highestScaleOrScaleJustRight(context, event, condMeta) {
  const actorContext = context.images.actorContext.get(
    context.images.updateRenderedName
  )

  if (actorContext.renderedScale === 0) {
    return true
  }

  let image = actorContext.image ?? actorContext.labelImage

  // is voxels count of next scale too much
  const nextScale = actorContext.renderedScale - 1
  const voxelCount = ['x', 'y', 'z']
    .map(dim => image.scaleInfo[nextScale].arrayShape.get(dim))
    .reduce((voxels, dimSize) => voxels * dimSize, 1)
  if (voxelCount > RENDERED_VOXEL_MAX) {
    return true
  }

  if (context.main.fps > 10.0 && context.main.fps < 33.0) {
    return true
  }
  if (condMeta.state.value.adjustScaleForFramerate === 'scaleJustRight') {
    return true
  }
  return false
}

function scaleTooHigh(context) {
  return context.main.fps <= 10.0
}

const eventResponses = {
  IMAGE_ASSIGNED: {
    target: 'updateRenderedImage',
    actions: assignUpdateRenderedNameToSelectedName,
  },
  LABEL_IMAGE_ASSIGNED: {
    target: 'updateRenderedImage',
    actions: assignUpdateRenderedNameToSelectedName,
  },
  UPDATE_RENDERED_IMAGE: {
    target: 'updateRenderedImage',
    actions: assignUpdateRenderedName,
  },
  RENDERED_IMAGE_ASSIGNED: {
    actions: 'applyRenderedImage',
  },
  TOGGLE_LAYER_VISIBILITY: {
    actions: 'toggleLayerVisibility',
  },
  SET_GRADIENT_OPACITY: {
    actions: 'applyGradientOpacity',
  },
  TOGGLE_IMAGE_INTERPOLATION: {
    actions: 'toggleInterpolation',
  },
  IMAGE_COMPONENT_VISIBILITY_CHANGED: {
    actions: 'applyComponentVisibility',
  },
  IMAGE_PIECEWISE_FUNCTION_CHANGED: {
    actions: 'applyPiecewiseFunction',
  },
  IMAGE_COLOR_RANGE_CHANGED: {
    actions: 'applyColorRange',
  },
  IMAGE_COLOR_MAP_CHANGED: {
    actions: 'applyColorMap',
  },
  TOGGLE_IMAGE_SHADOW: {
    actions: 'applyShadow',
  },
  IMAGE_GRADIENT_OPACITY_CHANGED: {
    actions: 'applyGradientOpacity',
  },
  IMAGE_GRADIENT_OPACITY_SCALE_CHANGED: {
    actions: 'applyGradientOpacity',
  },
  IMAGE_VOLUME_SAMPLE_DISTANCE_CHANGED: {
    actions: 'applyVolumeSampleDistance',
  },
  IMAGE_BLEND_MODE_CHANGED: {
    actions: 'applyBlendMode',
  },
  UPDATE_IMAGE_HISTOGRAM: {
    target: 'updateHistogram',
  },
  LABEL_IMAGE_LOOKUP_TABLE_CHANGED: {
    actions: 'applyLookupTable',
  },
  LABEL_IMAGE_BLEND_CHANGED: {
    actions: 'applyLabelImageBlend',
  },
  LABEL_IMAGE_WEIGHTS_CHANGED: {
    actions: 'applyLabelImageWeights',
  },
  LABEL_IMAGE_LABEL_NAMES_CHANGED: {
    actions: 'applyLabelNames',
  },
  LABEL_IMAGE_SELECTED_LABEL_CHANGED: {
    actions: 'applySelectedLabel',
  },
  SET_IMAGE_SCALE: {
    target: 'setImageScale',
    actions: 'updateIsFramerateScalePickingOn',
  },
  ADJUST_SCALE_FOR_FRAMERATE: {
    target: 'adjustScaleForFramerate',
  },
}

const createImageRenderingActor = (options, context /*, event*/) => {
  return Machine(
    {
      id: 'imageRendering',
      initial: 'idle',
      context,
      states: {
        idle: {
          invoke: {
            id: 'createImageRenderer',
            src: 'createImageRenderer',
            onDone: {
              target: 'updateRenderedImage',
              actions: assignUpdateRenderedNameToSelectedName,
            },
          },
        },
        imageBoundsDeboucing: {
          on: {
            ...eventResponses,
            CROPPING_PLANES_CHANGED: {
              target: 'imageBoundsDeboucing',
            },
          },
          after: {
            500: [
              {
                target: 'updateRenderedImage',
                cond: 'areBoundsBigger',
              },
              {
                target: 'adjustScaleForFramerate',
                cond: 'isFramerateScalePickingOn',
              },
              { target: 'updateHistogram' },
            ],
          },
        },
        updateRenderedImage: {
          invoke: {
            id: 'updateRenderedImage',
            src: 'updateRenderedImage',
            onDone: [
              {
                target: 'adjustScaleForFramerate',
                cond: 'isFramerateScalePickingOn',
              },
              { target: 'updateHistogram' },
            ],
          },
          on: {
            ...eventResponses,
          },
        },
        adjustScaleForFramerate: {
          entry: [c => c.service.send('UPDATE_FPS')],
          on: {
            ...eventResponses,
            FPS_UPDATED: [
              {
                target: 'updateHistogram',
                cond: highestScaleOrScaleJustRight,
              },
              {
                target: '.scaleJustRight',
                cond: scaleTooHigh,
              },
              {
                target: '.scaleTooLow',
                internal: false,
              },
            ],
          },
          initial: 'checkStarted',
          states: {
            checkStarted: {},
            scaleTooLow: {
              entry: assignHigherScale,
              invoke: {
                id: 'updateRenderedImageScaleTooLow',
                src: 'updateRenderedImage',
                onDone: {
                  actions: [c => c.service.send('UPDATE_FPS')],
                },
              },
            },
            scaleJustRight: {
              entry: assignLowerScale,
              invoke: {
                id: 'updateRenderedImageScaleJustRight',
                src: 'updateRenderedImage',
                onDone: {
                  actions: [c => c.service.send('UPDATE_FPS')],
                },
              },
            },
          },
        },
        setImageScale: {
          entry: assignRenderedScale,
          invoke: {
            id: 'updateRenderedImageSetImageScale',
            src: 'updateRenderedImage',
            onDone: {
              target: 'updateHistogram',
            },
          },
          on: eventResponses,
        },
        updateHistogram: {
          invoke: {
            id: 'updateHistogram',
            src: 'updateHistogram',
            onDone: {
              target: 'active',
            },
          },
          on: {
            ...eventResponses,
          },
        },
        active: {
          type: 'parallel',
          on: {
            ...eventResponses,
            CROPPING_PLANES_CHANGED: {
              target: 'imageBoundsDeboucing',
              cond: (context, event, condMeta) =>
                condMeta.state.history.event.type !==
                'IMAGE_PIECEWISE_FUNCTION_CHANGED',
            },
          },
          states: {
            independentComponents: {
              enabled: {},
              disabled: {},
            },
          },
        },
        finished: {
          type: 'final',
        },
        onDone: {
          //actions: 'cleanup'
        },
      },
    },
    options
  )
}

export default createImageRenderingActor

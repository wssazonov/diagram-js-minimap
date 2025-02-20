import {
  attr as domAttr,
  classes as domClasses,
  event as domEvent,
  query as domQuery,
  queryAll as domQueryAll
} from 'min-dom';

import {
  append as svgAppend,
  attr as svgAttr,
  classes as svgClasses,
  clear as svgClear,
  clone as svgClone,
  create as svgCreate,
  remove as svgRemove
} from 'tiny-svg';

import {
  assign,
  every,
  isNumber,
  isObject
} from 'min-dash';

import {
  escapeCSS as cssEscape
} from 'diagram-js/lib/util/EscapeUtil';

import { getVisual } from 'diagram-js/lib/util/GraphicsUtil';

import * as IdGeneratorModule from 'diagram-js/lib/util/IdGenerator';
const IdGenerator = IdGeneratorModule.default || IdGeneratorModule;

var MINIMAP_VIEWBOX_PADDING = 50;

var IDS = new IdGenerator();

var RANGE = { min: 0.2, max: 4 },
    NUM_STEPS = 10;

var DELTA_THRESHOLD = 0.1;

var LOW_PRIORITY = 250;


/**
 * A minimap that reflects and lets you navigate the diagram.
 */
export default function Minimap(
    config, injector, eventBus,
    canvas, elementRegistry) {

  var self = this;

  this._canvas = canvas;
  this._elementRegistry = elementRegistry;
  this._eventBus = eventBus;
  this._injector = injector;

  this._state = {
    isOpen: undefined,
    isDragging: false,
    initialDragPosition: null,
    offsetViewport: null,
    cachedViewbox: null,
    dragger: null,
    svgClientRect: null,
    parentClientRect: null,
    zoomDelta: 0
  };

  this._minimapId = IDS.next();

  this._init();

  this.toggle((config && config.open) || false);

  function centerViewbox(point) {

    // getBoundingClientRect might return zero-dimensional when called for the first time
    if (!self._state._svgClientRect || isZeroDimensional(self._state._svgClientRect)) {
      self._state._svgClientRect = self._svg.getBoundingClientRect();
    }

    var diagramPoint = mapMousePositionToDiagramPoint({
      x: point.x - self._state._svgClientRect.left,
      y: point.y - self._state._svgClientRect.top
    }, self._svg, self._lastViewbox);

    setViewboxCenteredAroundPoint(diagramPoint, self._canvas);

    self._update();
  }

  function mousedown(center) {

    return function onMousedown(event) {
      var point = getPoint(event);

      // getBoundingClientRect might return zero-dimensional when called for the first time
      if (!self._state._svgClientRect || isZeroDimensional(self._state._svgClientRect)) {
        self._state._svgClientRect = self._svg.getBoundingClientRect();
      }

      if (center) {
        centerViewbox(point);
      }

      var diagramPoint = mapMousePositionToDiagramPoint({
        x: point.x - self._state._svgClientRect.left,
        y: point.y - self._state._svgClientRect.top
      }, self._svg, self._lastViewbox);

      var viewbox = canvas.viewbox();

      var offsetViewport = getOffsetViewport(diagramPoint, viewbox);

      var initialViewportDomRect = self._viewportDom.getBoundingClientRect();

      // take border into account (regardless of width)
      var offsetViewportDom = {
        x: point.x - initialViewportDomRect.left + 1,
        y: point.y - initialViewportDomRect.top + 1
      };

      // init dragging
      assign(self._state, {
        cachedViewbox: viewbox,
        initialDragPosition: {
          x: point.x,
          y: point.y
        },
        isDragging: true,
        offsetViewport: offsetViewport,
        offsetViewportDom: offsetViewportDom,
        viewportClientRect: self._viewport.getBoundingClientRect(),
        parentClientRect: self._parent.getBoundingClientRect()
      });

      domEvent.bind(document, 'mousemove', onMousemove);
      domEvent.bind(document, 'mouseup', onMouseup);
    };
  }

  function onMousemove(event) {
    var point = getPoint(event);

    // set viewbox if dragging active
    if (self._state.isDragging) {

      // getBoundingClientRect might return zero-dimensional when called for the first time
      if (!self._state._svgClientRect || isZeroDimensional(self._state._svgClientRect)) {
        self._state._svgClientRect = self._svg.getBoundingClientRect();
      }

      // update viewport DOM
      var offsetViewportDom = self._state.offsetViewportDom,
          viewportClientRect = self._state.viewportClientRect,
          parentClientRect = self._state.parentClientRect;

      assign(self._viewportDom.style, {
        top: (point.y - offsetViewportDom.y - parentClientRect.top) + 'px',
        left: (point.x - offsetViewportDom.x - parentClientRect.left) + 'px'
      });

      // update overlay
      var clipPath = getOverlayClipPath(parentClientRect, {
        top: point.y - offsetViewportDom.y - parentClientRect.top,
        left: point.x - offsetViewportDom.x - parentClientRect.left,
        width: viewportClientRect.width,
        height: viewportClientRect.height
      });

      assign(self._overlay.style, {
        clipPath: clipPath
      });

      var diagramPoint = mapMousePositionToDiagramPoint({
        x: point.x - self._state._svgClientRect.left,
        y: point.y - self._state._svgClientRect.top
      }, self._svg, self._lastViewbox);

      setViewboxCenteredAroundPoint({
        x: diagramPoint.x - self._state.offsetViewport.x,
        y: diagramPoint.y - self._state.offsetViewport.y
      }, self._canvas);
    }
  }

  function onMouseup(event) {
    var point = getPoint(event);

    if (self._state.isDragging) {

      // treat event as click
      if (self._state.initialDragPosition.x === point.x
          && self._state.initialDragPosition.y === point.y) {
        centerViewbox(event);
      }

      self._update();

      // end dragging
      assign(self._state, {
        cachedViewbox: null,
        initialDragPosition: null,
        isDragging: false,
        offsetViewport: null,
        offsetViewportDom: null
      });

      domEvent.unbind(document, 'mousemove', onMousemove);
      domEvent.unbind(document, 'mouseup', onMouseup);
    }
  }

  // dragging viewport scrolls canvas
  domEvent.bind(this._viewportDom, 'mousedown', mousedown(false));
  domEvent.bind(this._svg, 'mousedown', mousedown(true));

  domEvent.bind(this._parent, 'wheel', function(event) {

    // stop propagation and handle scroll differently
    event.preventDefault();
    event.stopPropagation();

    // only zoom in on ctrl; this aligns with diagram-js navigation behavior
    if (!event.ctrlKey) {
      return;
    }

    // getBoundingClientRect might return zero-dimensional when called for the first time
    if (!self._state._svgClientRect || isZeroDimensional(self._state._svgClientRect)) {
      self._state._svgClientRect = self._svg.getBoundingClientRect();
    }

    // disallow zooming through viewport outside of minimap as it is very confusing
    if (!isPointInside(event, self._state._svgClientRect)) {
      return;
    }

    var factor = event.deltaMode === 0 ? 0.020 : 0.32;

    var delta = (
      Math.sqrt(
        Math.pow(event.deltaY, 2) +
        Math.pow(event.deltaX, 2)
      ) * sign(event.deltaY) * -factor
    );

    // add until threshold reached
    self._state.zoomDelta += delta;

    if (Math.abs(self._state.zoomDelta) > DELTA_THRESHOLD) {
      var direction = delta > 0 ? 1 : -1;

      var currentLinearZoomLevel = Math.log(canvas.zoom()) / Math.log(10);

      // zoom with half the step size of stepZoom
      var stepSize = getStepSize(RANGE, NUM_STEPS * 2);

      // snap to a proximate zoom step
      var newLinearZoomLevel = Math.round(currentLinearZoomLevel / stepSize) * stepSize;

      // increase or decrease one zoom step in the given direction
      newLinearZoomLevel += stepSize * direction;

      // calculate the absolute logarithmic zoom level based on the linear zoom level
      // (e.g. 2 for an absolute x2 zoom)
      var newLogZoomLevel = Math.pow(10, newLinearZoomLevel);

      canvas.zoom(cap(RANGE, newLogZoomLevel), diagramPoint);

      // reset
      self._state.zoomDelta = 0;

      var diagramPoint = mapMousePositionToDiagramPoint({
        x: event.clientX - self._state._svgClientRect.left,
        y: event.clientY - self._state._svgClientRect.top
      }, self._svg, self._lastViewbox);

      setViewboxCenteredAroundPoint(diagramPoint, self._canvas);

      self._update();
    }
  });

  domEvent.bind(this._toggle, 'click', function(event) {
    event.preventDefault();
    event.stopPropagation();

    self.toggle();
  });

  // add shape on shape/connection added
  eventBus.on([ 'shape.added', 'connection.added' ], function(context) {
    var element = context.element;

    self._addElement(element);

    self._update();
  });

  // remove shape on shape/connection removed
  eventBus.on([ 'shape.removed', 'connection.removed' ], function(context) {
    var element = context.element;

    self._removeElement(element);

    self._update();
  });

  // update on elements changed
  eventBus.on('elements.changed', LOW_PRIORITY, function(context) {
    var elements = context.elements;

    elements.forEach(function(element) {
      self._updateElement(element);
    });

    self._update();
  });

  // update on element ID update
  eventBus.on('element.updateId', function(context) {
    var element = context.element,
        newId = context.newId;

    self._updateElementId(element, newId);
  });

  // update on viewbox changed
  eventBus.on('canvas.viewbox.changed', function() {
    if (!self._state.isDragging) {
      self._update();
    }
  });

  eventBus.on('canvas.resized', function() {

    // only update if present in DOM
    if (document.body.contains(self._parent)) {
      if (!self._state.isDragging) {
        self._update();
      }

      self._state._svgClientRect = self._svg.getBoundingClientRect();
    }

  });

  eventBus.on([ 'root.set', 'plane.set' ], function(event) {
    self._clear();

    var element = event.element || event.plane.rootElement;

    element.children.forEach(function(el) {
      self._addElement(el);
    });

    self._update();
  });

}

Minimap.$inject = [
  'config.minimap',
  'injector',
  'eventBus',
  'canvas',
  'elementRegistry'
];

Minimap.prototype._init = function() {
  var canvas = this._canvas,
      container = canvas.getContainer();

  // create parent div
  var parent = this._parent = document.createElement('div');

  domClasses(parent).add('djs-minimap');

  container.appendChild(parent);

  // create toggle
  var toggle = this._toggle = document.createElement('div');

  domClasses(toggle).add('toggle');

  parent.appendChild(toggle);

  // create map
  var map = this._map = document.createElement('div');

  domClasses(map).add('map');

  parent.appendChild(map);

  // create svg
  var svg = this._svg = svgCreate('svg');
  svgAttr(svg, { width: '100%', height: '100%' });
  svgAppend(map, svg);

  // add groups
  var elementsGroup = this._elementsGroup = svgCreate('g');
  svgAppend(svg, elementsGroup);

  var viewportGroup = this._viewportGroup = svgCreate('g');
  svgAppend(svg, viewportGroup);

  // add viewport SVG
  var viewport = this._viewport = svgCreate('rect');

  svgClasses(viewport).add('viewport');

  svgAppend(viewportGroup, viewport);

  // prevent drag propagation
  domEvent.bind(parent, 'mousedown', function(event) {
    event.stopPropagation();
  });

  // add viewport DOM
  var viewportDom = this._viewportDom = document.createElement('div');

  domClasses(viewportDom).add('viewport-dom');

  this._parent.appendChild(viewportDom);

  // add overlay
  var overlay = this._overlay = document.createElement('div');

  domClasses(overlay).add('overlay');

  this._parent.appendChild(overlay);
};

Minimap.prototype._update = function() {
  var viewbox = this._canvas.viewbox(),
      innerViewbox = viewbox.inner,
      outerViewbox = viewbox.outer;

  if (!validViewbox(viewbox)) {
    return;
  }

  var x, y, width, height;

  var widthDifference = outerViewbox.width - innerViewbox.width,
      heightDifference = outerViewbox.height - innerViewbox.height;

  // update viewbox
  // x
  if (innerViewbox.width < outerViewbox.width) {
    x = innerViewbox.x - widthDifference / 2;
    width = outerViewbox.width;

    if (innerViewbox.x + innerViewbox.width < outerViewbox.width) {
      x = Math.min(0, innerViewbox.x);
    }
  } else {
    x = innerViewbox.x;
    width = innerViewbox.width;
  }

  // y
  if (innerViewbox.height < outerViewbox.height) {
    y = innerViewbox.y - heightDifference / 2;
    height = outerViewbox.height;

    if (innerViewbox.y + innerViewbox.height < outerViewbox.height) {
      y = Math.min(0, innerViewbox.y);
    }
  } else {
    y = innerViewbox.y;
    height = innerViewbox.height;
  }

  // apply some padding
  x = x - MINIMAP_VIEWBOX_PADDING;
  y = y - MINIMAP_VIEWBOX_PADDING;
  width = width + MINIMAP_VIEWBOX_PADDING * 2;
  height = height + MINIMAP_VIEWBOX_PADDING * 2;

  this._lastViewbox = {
    x: x,
    y: y,
    width: width,
    height: height
  };

  svgAttr(this._svg, {
    viewBox: x + ', ' + y + ', ' + width + ', ' + height
  });

  // update viewport SVG
  svgAttr(this._viewport, {
    x: viewbox.x,
    y: viewbox.y,
    width: viewbox.width,
    height: viewbox.height
  });

  // update viewport DOM
  var parentClientRect = this._state._parentClientRect = this._parent.getBoundingClientRect();
  var viewportClientRect = this._viewport.getBoundingClientRect();

  var withoutParentOffset = {
    top: viewportClientRect.top - parentClientRect.top,
    left: viewportClientRect.left - parentClientRect.left,
    width: viewportClientRect.width,
    height: viewportClientRect.height
  };

  assign(this._viewportDom.style, {
    top: withoutParentOffset.top + 'px',
    left: withoutParentOffset.left + 'px',
    width: withoutParentOffset.width + 'px',
    height: withoutParentOffset.height + 'px'
  });

  // update overlay
  var clipPath = getOverlayClipPath(parentClientRect, withoutParentOffset);

  assign(this._overlay.style, {
    clipPath: clipPath
  });
};

Minimap.prototype.open = function() {
  assign(this._state, { isOpen: true });

  domClasses(this._parent).add('open');

  var translate = this._injector.get('translate', false) || function(s) { return s; };

  domAttr(this._toggle, 'title', translate('Close minimap'));

  this._update();

  this._eventBus.fire('minimap.toggle', { open: true });
};

Minimap.prototype.close = function() {
  assign(this._state, { isOpen: false });

  domClasses(this._parent).remove('open');

  var translate = this._injector.get('translate', false) || function(s) { return s; };

  domAttr(this._toggle, 'title', translate('Open minimap'));

  this._eventBus.fire('minimap.toggle', { open: false });
};

Minimap.prototype.toggle = function(open) {

  var currentOpen = this.isOpen();

  if (typeof open === 'undefined') {
    open = !currentOpen;
  }

  if (open == currentOpen) {
    return;
  }

  if (open) {
    this.open();
  } else {
    this.close();
  }
};

Minimap.prototype.isOpen = function() {
  return this._state.isOpen;
};

Minimap.prototype._updateElement = function(element) {

  try {

    // if parent is null element has been removed, if parent is undefined parent is root
    if (element.parent !== undefined && element.parent !== null) {
      this._removeElement(element);
      this._addElement(element);
    }
  } catch (error) {
    console.warn('Minimap#_updateElement errored', error);
  }

};

Minimap.prototype._updateElementId = function(element, newId) {

  try {
    var elementGfx = domQuery('#' + cssEscape(this._prefixId(element.id)), this._elementsGroup);

    if (elementGfx) {
      elementGfx.id = this._prefixId(newId);
    }
  } catch (error) {
    console.warn('Minimap#_updateElementId errored', error);
  }

};

/**
 * Checks if an element is on the currently active plane.
 */
Minimap.prototype.isOnActivePlane = function(element) {
  var canvas = this._canvas;

  // diagram-js@8
  if (canvas.findRoot) {
    return canvas.findRoot(element) === canvas.getRootElement();
  }

  // diagram-js>=7.4.0
  if (canvas.findPlane) {
    return canvas.findPlane(element) === canvas.getActivePlane();
  }

  // diagram-js<7.4.0
  return true;
};


/**
 * Adds an element to the minimap.
 */
Minimap.prototype._addElement = function(element) {
  var self = this;

  this._removeElement(element);

  if (!this.isOnActivePlane(element)) {
    return;
  }

  var parent,
      x, y;

  var newElementGfx = this._createElement(element);
  var newElementParentGfx = domQuery('#' + cssEscape(this._prefixId(element.parent.id)), this._elementsGroup);

  if (newElementGfx) {

    var elementGfx = this._elementRegistry.getGraphics(element);
    var parentGfx = this._elementRegistry.getGraphics(element.parent);

    var index = getIndexOfChildInParentChildren(elementGfx, parentGfx);

    // index can be 0
    if (index !== 'undefined') {
      if (newElementParentGfx) {

        // in cases of doubt add as last child
        if (newElementParentGfx.childNodes.length > index) {
          insertChildAtIndex(newElementGfx, newElementParentGfx, index);
        } else {
          insertChildAtIndex(newElementGfx, newElementParentGfx, newElementParentGfx.childNodes.length - 1);
        }

      } else {
        this._elementsGroup.appendChild(newElementGfx);
      }

    } else {

      // index undefined
      this._elementsGroup.appendChild(newElementGfx);
    }

    if (isConnection(element)) {
      parent = element.parent;
      x = 0;
      y = 0;

      if (typeof parent.x !== 'undefined' && typeof parent.y !== 'undefined') {
        x = -parent.x;
        y = -parent.y;
      }

      svgAttr(newElementGfx, { transform: 'translate(' + x + ' ' + y + ')' });
    } else {
      x = element.x;
      y = element.y;

      if (newElementParentGfx) {
        parent = element.parent;

        x -= parent.x;
        y -= parent.y;
      }

      svgAttr(newElementGfx, { transform: 'translate(' + x + ' ' + y + ')' });
    }

    if (element.children && element.children.length) {
      element.children.forEach(function(child) {
        self._addElement(child);
      });
    }

    return newElementGfx;
  }
};

Minimap.prototype._removeElement = function(element) {
  var elementGfx = this._svg.getElementById(this._prefixId(element.id));

  if (elementGfx) {
    svgRemove(elementGfx);
  }
};

Minimap.prototype._createElement = function(element) {
  var gfx = this._elementRegistry.getGraphics(element),
      visual;

  if (gfx) {
    visual = getVisual(gfx);

    if (visual) {
      var elementGfx = sanitize(svgClone(visual));

      svgAttr(elementGfx, { id: this._prefixId(element.id) });

      return elementGfx;
    }
  }
};

Minimap.prototype._clear = function() {
  svgClear(this._elementsGroup);
};

Minimap.prototype._prefixId = function(id) {
  return 'djs-minimap-' + id + '-' + this._minimapId;
};


function isConnection(element) {
  return element.waypoints;
}

function getOffsetViewport(diagramPoint, viewbox) {
  var viewboxCenter = {
    x: viewbox.x + (viewbox.width / 2),
    y: viewbox.y + (viewbox.height / 2)
  };

  return {
    x: diagramPoint.x - viewboxCenter.x,
    y: diagramPoint.y - viewboxCenter.y
  };
}

function mapMousePositionToDiagramPoint(position, svg, lastViewbox) {

  // firefox returns 0 for clientWidth and clientHeight
  var boundingClientRect = svg.getBoundingClientRect();

  // take different aspect ratios of default layers bounding box and minimap into account
  var bBox =
    fitAspectRatio(lastViewbox, boundingClientRect.width / boundingClientRect.height);

  // map click position to diagram position
  var diagramX = map(position.x, 0, boundingClientRect.width, bBox.x, bBox.x + bBox.width),
      diagramY = map(position.y, 0, boundingClientRect.height, bBox.y, bBox.y + bBox.height);

  return {
    x: diagramX,
    y: diagramY
  };
}

function setViewboxCenteredAroundPoint(point, canvas) {

  // get cached viewbox to preserve zoom
  var cachedViewbox = canvas.viewbox(),
      cachedViewboxWidth = cachedViewbox.width,
      cachedViewboxHeight = cachedViewbox.height;

  canvas.viewbox({
    x: point.x - cachedViewboxWidth / 2,
    y: point.y - cachedViewboxHeight / 2,
    width: cachedViewboxWidth,
    height: cachedViewboxHeight
  });
}

function fitAspectRatio(bounds, targetAspectRatio) {
  var aspectRatio = bounds.width / bounds.height;

  // assigning to bounds throws exception in IE11
  var newBounds = assign({}, {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  });

  if (aspectRatio > targetAspectRatio) {

    // height needs to be fitted
    var height = newBounds.width * (1 / targetAspectRatio),
        y = newBounds.y - ((height - newBounds.height) / 2);

    assign(newBounds, {
      y: y,
      height: height
    });
  } else if (aspectRatio < targetAspectRatio) {

    // width needs to be fitted
    var width = newBounds.height * targetAspectRatio,
        x = newBounds.x - ((width - newBounds.width) / 2);

    assign(newBounds, {
      x: x,
      width: width
    });
  }

  return newBounds;
}

function map(x, inMin, inMax, outMin, outMax) {
  var inRange = inMax - inMin,
      outRange = outMax - outMin;

  return (x - inMin) * outRange / inRange + outMin;
}

/**
 * Returns index of child in children of parent.
 *
 * g
 * '- g.djs-element // parentGfx
 * '- g.djs-children
 *    '- g
 *       '-g.djs-element // childGfx
 */
function getIndexOfChildInParentChildren(childGfx, parentGfx) {
  var childrenGroup = domQuery('.djs-children', parentGfx.parentNode);

  if (!childrenGroup) {
    return;
  }

  var childrenArray = [].slice.call(childrenGroup.childNodes);

  var indexOfChild = -1;

  childrenArray.forEach(function(childGroup, index) {
    if (domQuery('.djs-element', childGroup) === childGfx) {
      indexOfChild = index;
    }
  });

  return indexOfChild;
}

function insertChildAtIndex(childGfx, parentGfx, index) {
  var childContainer = getChildContainer(parentGfx);

  var childrenArray = [].slice.call(childContainer.childNodes);

  var childAtIndex = childrenArray[index];

  if (childAtIndex) {
    parentGfx.insertBefore(childGfx, childAtIndex.nextSibling);
  } else {
    parentGfx.appendChild(childGfx);
  }
}

function getChildContainer(parentGfx) {
  var container = domQuery('.children', parentGfx);

  if (!container) {
    container = svgCreate('g', { class: 'children' });
    svgAppend(parentGfx, container);
  }

  return container;
}

function isZeroDimensional(clientRect) {
  return clientRect.width === 0 && clientRect.height === 0;
}

function isPointInside(point, rect) {
  return point.x > rect.left
    && point.x < rect.left + rect.width
    && point.y > rect.top
    && point.y < rect.top + rect.height;
}

var sign = Math.sign || function(n) {
  return n >= 0 ? 1 : -1;
};

/**
 * Get step size for given range and number of steps.
 *
 * @param {Object} range - Range.
 * @param {number} range.min - Range minimum.
 * @param {number} range.max - Range maximum.
 */
function getStepSize(range, steps) {

  var minLinearRange = Math.log(range.min) / Math.log(10),
      maxLinearRange = Math.log(range.max) / Math.log(10);

  var absoluteLinearRange = Math.abs(minLinearRange) + Math.abs(maxLinearRange);

  return absoluteLinearRange / steps;
}

function cap(range, scale) {
  return Math.max(range.min, Math.min(range.max, scale));
}

function getOverlayClipPath(outer, inner) {
  var coordinates = [
    toCoordinatesString(inner.left, inner.top),
    toCoordinatesString(inner.left + inner.width, inner.top),
    toCoordinatesString(inner.left + inner.width, inner.top + inner.height),
    toCoordinatesString(inner.left, inner.top + inner.height),
    toCoordinatesString(inner.left, outer.height),
    toCoordinatesString(outer.width, outer.height),
    toCoordinatesString(outer.width, 0),
    toCoordinatesString(0, 0),
    toCoordinatesString(0, outer.height),
    toCoordinatesString(inner.left, outer.height)
  ].join(', ');

  return 'polygon(' + coordinates + ')';
}

function toCoordinatesString(x, y) {
  return x + 'px ' + y + 'px';
}

function validViewbox(viewBox) {

  return every(viewBox, function(value) {

    // check deeper structures like inner or outer viewbox
    if (isObject(value)) {
      return validViewbox(value);
    }

    return isNumber(value) && isFinite(value);
  });
}

function getPoint(event) {
  if (event.center) {
    return event.center;
  }

  return {
    x: event.clientX,
    y: event.clientY
  };
}

// removes all elements with an id attribute
function sanitize(gfx) {
  domQueryAll('[id]', gfx).forEach(function(element) {
    element.remove();
  });

  return gfx;
}

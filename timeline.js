// SPDX-FileCopyrightText: 2026 CERN
// SPDX-License-Identifier: BSD-3-Clause

class CanvasTimeline {
    #canvas;
    #groups;
    #maximum;
    #on_context_menu;
    #name_pane_width;
    #font_size;
    #scroll_top;
    #start;
    #end;
    #expanded;
    #spans;
    #drag;
    #width;
    #height;
    #context;
    #axis_height;
    #row_height;
    #minimum_timeline_pane_width;

    constructor(canvas, items, groups, maximum, on_context_menu, font_size) {
        this.#canvas = canvas;
        this.#maximum = maximum;
        this.#on_context_menu = on_context_menu;
        this.#name_pane_width = 260;
        this.#font_size = font_size;
        this.#setFontMetrics();
        this.#scroll_top = 0;
        this.#start = 0;
        this.#expanded = new Set();
        this.#spans = new Map();
        this.#drag = undefined;

        this.#groups = new Map();

        let collator = new Intl.Collator();
        let groups_sorted = groups.toSorted((a, b) => collator.compare(a.id, b.id));

        for (const group of groups_sorted) {
            group.nestedGroups?.sort(collator.compare);
            this.#groups.set(group.id, group);
        }

        for (const item of items) {
            if (!this.#spans.has(item.group)) {
                this.#spans.set(item.group, new Map());
            }
            let order = Number(item.order ?? 0);
            order = Number.isFinite(order) ? order : 0;
            let spans_by_layer = this.#spans.get(item.group);
            if (!spans_by_layer.has(order)) {
                spans_by_layer.set(order, []);
            }
            spans_by_layer.get(order).push({
                start: item.start,
                end: item.end,
                color: item.color,
                content: item.content ?? '',
                textColor: item.textColor ?? '#000000'
            });
        }

        let overall_maximum = -Infinity;

        for (const spans_by_layer of this.#spans.values()) {
            for (const spans of spans_by_layer.values()) {
                spans.sort((a, b) => a.start - b.start);
                let maximum_end = -Infinity;
                for (const span of spans) {
                    maximum_end = Math.max(maximum_end, span.end);
                    span.maximum_end = maximum_end;
                    overall_maximum = Math.max(overall_maximum, maximum_end);
                }
            }
        }

        this.#end = Math.min(1.1 * overall_maximum, maximum);

        canvas.addEventListener('contextmenu', event => this.#contextMenu(event));
        canvas.addEventListener('mousedown', event => this.#mouseDown(event));
        canvas.addEventListener('mousemove', event => this.#mouseMove(event));
        canvas.addEventListener('mouseup', event => this.#mouseUp());
        canvas.addEventListener('mouseleave', event => this.#mouseUp());
        canvas.addEventListener('wheel', event => this.#wheel(event), {passive: false});
        this.resize();
    }

    #visibleGroups() {
        let visible = [];

        let recurse = group => {
            visible.push(group);

            if (group.nestedGroups != undefined && this.#expanded.has(group.id)) {
                for (const subgroup_id of group.nestedGroups) {
                    recurse(this.#groups.get(subgroup_id));
                }
            }
        };

        for (const group of this.#groups.values()) {
            if (group.level === 0) {
                recurse(group);
            }
        }

        return visible;
    }

    #setFontMetrics() {
        this.#axis_height = Math.max(32, this.#font_size + 20);
        this.#row_height = Math.max(24, this.#font_size + 12);
    }

    #font(weight = '') {
        return weight + ' ' + this.#font_size + 'px Arial';
    }

    #axisFont() {
        return Math.max(6, this.#font_size - 2) + 'px Arial';
    }

    changeFontSize(change) {
        this.#font_size = Math.max(8, Math.min(24, this.#font_size + change));
        this.#setFontMetrics();
        this.#render();
        return this.#font_size;
    }

    resize() {
        let bounds = this.#canvas.getBoundingClientRect();
        let ratio = window.devicePixelRatio || 1;
        this.#width = Math.max(1, bounds.width);
        this.#height = Math.max(1, bounds.height);
        this.#canvas.width = Math.round(this.#width * ratio);
        this.#canvas.height = Math.round(this.#height * ratio);
        this.#context = this.#canvas.getContext('2d');
        this.#context.setTransform(ratio, 0, 0, ratio, 0, 0);
        this.#render();
    }

    #timeToX(time) {
        return this.#name_pane_width + (time - this.#start) *
            (this.#width - this.#name_pane_width) / (this.#end - this.#start);
    }

    #groupAt(event) {
        let bounds = this.#canvas.getBoundingClientRect();
        let row = Math.floor((event.clientY - bounds.top - this.#axis_height + this.#scroll_top) /
                             this.#row_height);
        return this.#visibleGroups()[row];
    }

    #render() {
        if (this.#context == undefined) {
            return;
        }

        let context = this.#context;
        let groups = this.#visibleGroups();
        let rows_height = Math.max(0, this.#height - this.#axis_height);
        let maximum_scroll = Math.max(0, groups.length * this.#row_height - rows_height);
        this.#scroll_top = Math.max(0, Math.min(this.#scroll_top, maximum_scroll));
        context.clearRect(0, 0, this.#width, this.#height);
        context.font = this.#axisFont();
        context.textBaseline = 'middle';
        let axis = this.#axisConfiguration();
        this.#minimum_timeline_pane_width = axis.minimum_pane_width;
        this.#name_pane_width = Math.min(this.#width - this.#minimum_timeline_pane_width,
                                         Math.max(this.#name_pane_width, this.#minimumLabelWidth()));

        context.fillStyle = '#f5f5f5';
        context.fillRect(0, 0, this.#width, this.#axis_height);
        context.strokeStyle = '#aaaaaa';
        context.beginPath();
        context.moveTo(0, this.#axis_height - 0.5);
        context.lineTo(this.#width, this.#axis_height - 0.5);
        context.moveTo(this.#name_pane_width - 0.5, 0);
        context.lineTo(this.#name_pane_width - 0.5, this.#height);
        context.stroke();

        let tick_positions = [];
        context.fillStyle = '#333333';
        context.strokeStyle = '#dddddd';
        for (let time = axis.first_tick; time <= this.#end; time += axis.step) {
            let x = this.#timeToX(time);
            tick_positions.push(x);
            context.beginPath();
            context.moveTo(x + 0.5, this.#axis_height);
            context.lineTo(x + 0.5, this.#height);
            context.stroke();
            let label = axis.number_format.format(time / axis.unit[1]) + ' ' + axis.unit[0];
            context.fillText(label, x + 3, this.#axis_height / 2);
        }

        context.font = this.#font();
        let first_row = Math.max(0, Math.floor(this.#scroll_top / this.#row_height));
        let last_row = Math.min(groups.length,
                                Math.ceil((this.#scroll_top + rows_height) / this.#row_height));
        context.save();
        context.beginPath();
        context.rect(0, this.#axis_height, this.#width, rows_height);
        context.clip();
        for (let index = first_row; index < last_row; index++) {
            let group = groups[index];
            let y = this.#axis_height + index * this.#row_height - this.#scroll_top;
            context.fillStyle = index % 2 === 0 ? '#ffffff' : '#fafafa';
            context.fillRect(0, y, this.#width, this.#row_height);
            context.strokeStyle = '#eeeeee';
            context.beginPath();
            context.moveTo(0, y + this.#row_height - 0.5);
            context.lineTo(this.#width, y + this.#row_height - 0.5);
            context.stroke();
            context.strokeStyle = '#dddddd';
            for (const x of tick_positions) {
                context.beginPath();
                context.moveTo(x + 0.5, y);
                context.lineTo(x + 0.5, y + this.#row_height);
                context.stroke();
            }
            context.strokeStyle = '#aaaaaa';
            context.beginPath();
            context.moveTo(this.#name_pane_width - 0.5, y);
            context.lineTo(this.#name_pane_width - 0.5, y + this.#row_height);
            context.stroke();

            let indent = group.level * 18 + 5;
            context.fillStyle = '#111111';
            if (group.nestedGroups != undefined) {
                let icon_size = this.#expandIconSize();
                this.#drawExpandIcon(indent, y + (this.#row_height - icon_size) / 2,
                                     this.#expanded.has(group.id));
                indent += icon_size + 4;
            }
            this.#drawLabel(this.#truncatedLabel(group.label, indent), indent,
                            y + this.#row_height / 2);

            let spans_by_layer = this.#spans.get(group.id);
            if (spans_by_layer != undefined) {
                let layers = [...spans_by_layer.entries()].sort((a, b) => a[0] - b[0]);
                for (const [, spans] of layers) {
                    let span_index = this.#firstVisibleSpan(spans);
                    for (; span_index < spans.length && spans[span_index].start <= this.#end; span_index++) {
                        let span = spans[span_index];
                        if (span.end < this.#start) {
                            continue;
                        }
                        let left = Math.max(this.#name_pane_width, this.#timeToX(span.start));
                        let right = Math.min(this.#width, this.#timeToX(span.end));
                        if (right > left) {
                            context.fillStyle = span.color;
                            context.fillRect(left, y + 2, Math.max(1, right - left), this.#row_height - 4);
                            this.#drawItemContent(span, left, right, y);
                        }
                    }
                }
            }
        }
        context.restore();
    }

    #axisConfiguration() {
        let duration = this.#end - this.#start;
        let raw_step = duration / 8;
        let power = Math.pow(10, Math.floor(Math.log10(raw_step)));
        let step = [1, 2, 5, 10].find(value => value * power >= raw_step) * power;
        let first_tick = Math.ceil(this.#start / step) * step;
        let unit = step >= 1000 ? ['s', 1000] :
            (step >= 1 ? ['ms', 1] : (step >= 0.001 ? ['us', 0.001] : ['ns', 0.000001]));
        let precision = Math.max(0, -Math.floor(Math.log10(step / unit[1])));
        let number_format = new Intl.NumberFormat('en-US', {
            minimumFractionDigits: precision,
            maximumFractionDigits: precision
        });
        let maximum_label_width = 0;
        for (let time = first_tick; time <= this.#end; time += step) {
            maximum_label_width = Math.max(maximum_label_width, this.#context.measureText(
                number_format.format(time / unit[1]) + ' ' + unit[0]).width);
        }
        return {
            step: step,
            first_tick: first_tick,
            unit: unit,
            number_format: number_format,
            minimum_pane_width: Math.ceil(Math.max(
                120, duration / step * (maximum_label_width + 6)))
        };
    }

    #drawItemContent(item, left, right, y) {
        let available_width = right - left - 8;
        if (item.content === '' || available_width <= 0) {
            return;
        }
        let original_content = String(item.content);
        let content = original_content;
        while (content.length > 0 && this.#context.measureText(content + '...').width > available_width) {
            content = content.slice(0, -1);
        }
        if (content.length === 0 && this.#context.measureText('...').width > available_width) {
            return;
        }
        if (content !== original_content) {
            content += '...';
        }
        this.#context.save();
        this.#context.beginPath();
        this.#context.rect(left, y + 2, right - left, this.#row_height - 4);
        this.#context.clip();
        this.#context.fillStyle = item.textColor;
        this.#context.fillText(content, left + 4, y + this.#row_height / 2);
        this.#context.restore();
    }

    #firstVisibleSpan(spans) {
        let low = 0;
        let high = spans.length;
        while (low < high) {
            let middle = Math.floor((low + high) / 2);
            if (spans[middle].maximum_end < this.#start) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return low;
    }

    #truncatedLabel(label, indent) {
        let segments = this.#labelSegments(label);
        let plain_text = segments.map(segment => segment.text).join('');
        let available_width = this.#name_pane_width - indent - 4;
        if (this.#measureLabel(segments) <= available_width) {
            return {segments: segments, plain_text: plain_text, truncated: false};
        }

        let ellipsis = {text: '...', bold: false, color: undefined};
        if (this.#measureLabel([ellipsis]) > available_width) {
            return {segments: [], plain_text: plain_text, truncated: true};
        }

        let retained = [];
        outer:
        for (const segment of segments) {
            for (const character of segment.text) {
                let previous_length = retained.length;
                let previous_text = previous_length === 0 ? undefined :
                    retained[previous_length - 1].text;
                this.#appendLabelSegment(retained, {
                    text: character,
                    bold: segment.bold,
                    color: segment.color
                });
                if (this.#measureLabel(retained.concat(ellipsis)) > available_width) {
                    retained.length = previous_length;
                    if (previous_length > 0) {
                        retained[previous_length - 1].text = previous_text;
                    }
                    break outer;
                }
            }
        }
        this.#appendLabelSegment(retained, ellipsis);
        return {segments: retained, plain_text: plain_text, truncated: true};
    }

    #minimumLabelWidth() {
        let minimum_width = 120;
        for (const group of this.#groups.values()) {
            let indent = group.level * 18 + 5;
            if (group.nestedGroups !== undefined) {
                indent += this.#expandIconSize() + 4;
            }
            minimum_width = Math.max(minimum_width,
                                     indent + this.#measureLabel([
                                         {text: '...', bold: false, color: undefined}
                                     ]) + 4);
        }
        return Math.ceil(minimum_width);
    }

    #appendLabelSegment(segments, segment) {
        if (segment.text === '') {
            return;
        }
        let previous = segments[segments.length - 1];
        if (previous !== undefined && previous.bold === segment.bold &&
            previous.color === segment.color) {
            previous.text += segment.text;
        } else {
            segments.push({text: segment.text, bold: segment.bold, color: segment.color});
        }
    }

    #labelColor(value) {
        if (value == null) {
            return undefined;
        }
        let color = String(value).trim();
        if (color === '' || /^(?:currentcolor|inherit|initial|none|revert(?:-layer)?|unset)$/i.test(color) ||
            /\b(?:calc|env|var)\s*\(/i.test(color)) {
            return undefined;
        }
        let element = document.createElement('span');
        element.style.color = color;
        return element.style.color === '' ? undefined : color;
    }

    #labelSegments(label) {
        let template = document.createElement('template');
        template.innerHTML = String(label);
        let segments = [];

        let visit = (node, formatting) => {
            if (node.nodeType === 3) {
                this.#appendLabelSegment(segments, {
                    text: node.nodeValue,
                    bold: formatting.bold,
                    color: formatting.color
                });
                return;
            }
            if (node.nodeType !== 1) {
                return;
            }
            let tag = node.tagName.toLowerCase();
            if (tag === 'script' || tag === 'style') {
                return;
            }
            let child_formatting = formatting;
            if (tag === 'b') {
                child_formatting = {bold: true, color: formatting.color};
            } else if (tag === 'font') {
                child_formatting = {bold: formatting.bold, color: formatting.color};
                let color = this.#labelColor(node.getAttribute('color'));
                if (color !== undefined) {
                    child_formatting.color = color;
                }
            }
            let children = tag === 'template' ? node.content.childNodes : node.childNodes;
            for (const child of children) {
                visit(child, child_formatting);
            }
        };

        for (const child of template.content.childNodes) {
            visit(child, {bold: false, color: undefined});
        }
        return segments;
    }

    #measureLabel(segments) {
        this.#context.save();
        let width = 0;
        for (const segment of segments) {
            this.#context.font = this.#font(segment.bold ? 'bold' : '');
            width += this.#context.measureText(segment.text).width;
        }
        this.#context.restore();
        return width;
    }

    #drawLabel(label, x, y) {
        this.#context.save();
        for (const segment of label.segments) {
            this.#context.font = this.#font(segment.bold ? 'bold' : '');
            this.#context.fillStyle = segment.color ?? '#111111';
            this.#context.fillText(segment.text, x, y);
            x += this.#context.measureText(segment.text).width;
        }
        this.#context.restore();
    }

    #expandIconSize() {
        return this.#font_size + 2;
    }

    #drawExpandIcon(x, y, expanded) {
        // ***
        // The paths below are based on the Google Material Icons SVGs, licensing:
        // SPDX-FileCopyrightText: Google
        // SPDX-License-Identifier: Apache-2.0
        const EXPAND_ICON_PATH = new Path2D(
            'M440-280h80v-160h160v-80H520v-160h-80v160H280v80h160v160ZM200-120q-33 ' +
                '0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 ' +
                '23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm0-560v560-560Z');
        const COLLAPSE_ICON_PATH = new Path2D(
            'M280-520h400v80H280v-80ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 ' +
                '23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 ' +
                '56.5T760-120H200Zm0-80h560v-560H200v560Zm0-560v560-560Z');
        // ***

        let icon_size = this.#expandIconSize();
        this.#context.save();
        this.#context.translate(x, y + icon_size);
        this.#context.scale(icon_size / 960, icon_size / 960);
        this.#context.fillStyle = '#000000';
        this.#context.fill(expanded ? COLLAPSE_ICON_PATH : EXPAND_ICON_PATH);
        this.#context.restore();
    }

    #updateTitle(event) {
        let bounds = this.#canvas.getBoundingClientRect();
        let group = this.#groupAt(event);
        if (event.clientX - bounds.left >= this.#name_pane_width || group === undefined) {
            this.#canvas.title = '';
            return;
        }
        let indent = group.level * 18 + 5 +
            (group.nestedGroups === undefined ? 0 : this.#expandIconSize() + 4);
        let label = this.#truncatedLabel(group.label, indent);
        this.#canvas.title = label.truncated ? label.plain_text : '';
    }

    #contextMenu(event) {
        let group = this.#groupAt(event);
        if (group != undefined) {
            this.#on_context_menu({group: group.id, pageX: event.pageX, pageY: event.pageY, event: event});
        }
    }

    #mouseDown(event) {
        if (event.button !== 0) {
            return;
        }
        let bounds = this.#canvas.getBoundingClientRect();
        let group = this.#groupAt(event);
        let x = event.clientX - bounds.left;
        if (Math.abs(x - this.#name_pane_width) <= 5) {
            this.#drag = {type: 'resize', x: event.clientX, label_width: this.#name_pane_width};
            this.#canvas.style.cursor = 'col-resize';
            return;
        }
        if (x < this.#name_pane_width && group !== undefined) {
            if (group.nestedGroups !== undefined) {
                if (this.#expanded.has(group.id)) {
                    this.#expanded.delete(group.id);
                } else {
                    this.#expanded.add(group.id);
                }
                this.#render();
            }
            return;
        }
        this.#drag = {type: 'pan', x: event.clientX, start: this.#start, end: this.#end};
        this.#canvas.style.cursor = 'grabbing';
    }

    #mouseMove(event) {
        this.#updateTitle(event);
        if (this.#drag === undefined) {
            let bounds = this.#canvas.getBoundingClientRect();
            this.#canvas.style.cursor = Math.abs(event.clientX - bounds.left - this.#name_pane_width) <= 5 ?
                'col-resize' : '';
            return;
        }
        if (this.#drag.type === 'resize') {
            this.#name_pane_width = Math.min(this.#width - this.#minimum_timeline_pane_width, Math.max(
                this.#minimumLabelWidth(), this.#drag.label_width + event.clientX - this.#drag.x));
            this.#render();
            return;
        }
        let delta = (event.clientX - this.#drag.x) * (this.#drag.end - this.#drag.start) /
            (this.#width - this.#name_pane_width);
        let duration = this.#drag.end - this.#drag.start;
        this.#start = Math.max(0, Math.min(this.#maximum - duration, this.#drag.start - delta));
        this.#end = this.#start + duration;
        this.#render();
    }

    #mouseUp() {
        this.#drag = undefined;
        this.#canvas.style.cursor = '';
    }

    #wheel(event) {
        event.preventDefault();
        let bounds = this.#canvas.getBoundingClientRect();
        if (event.shiftKey || event.clientX - bounds.left < this.#name_pane_width) {
            this.#scroll_top += event.deltaY;
        } else {
            let duration = this.#end - this.#start;
            let factor = event.deltaY < 0 ? 0.8 : 1.25;
            let new_duration = Math.max(0.001, Math.min(this.#maximum, duration * factor));
            let position = Math.max(0, Math.min(1, (event.clientX - bounds.left - this.#name_pane_width) /
                                                (this.#width - this.#name_pane_width)));
            this.#start += (duration - new_duration) * position;
            this.#start = Math.max(0, Math.min(this.#maximum - new_duration, this.#start));
            this.#end = this.#start + new_duration;
        }
        this.#render();
    }
}

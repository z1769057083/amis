/**
 * @file table/BodyCell
 * @author fex
 */

import React from 'react';

import {ThemeProps, ClassNamesFn} from 'amis-core';

import {ColumnProps} from './index';
import type {TestIdBuilder} from 'amis-core';

const zIndex = 1;

export interface Props extends ThemeProps {
  fixed?: string | boolean; // left | right
  rowSpan?: number | any;
  colSpan?: number | any;
  key?: string | number;
  className?: string;
  children?: any;
  tagName?: string;
  style?: Object;
  column?: ColumnProps;
  wrapperComponent: any;
  depth?: number; // 表头分组
  col?: string;
  index?: number;
  classnames: ClassNamesFn;
  testIdBuilder?: TestIdBuilder;
}

export default class BodyCell extends React.PureComponent<Props> {
  static defaultProps = {
    fixed: '',
    wrapperComponent: 'td',
    rowSpan: null,
    colSpan: null
  };

  render() {
    const {
      fixed,
      rowSpan,
      colSpan,
      children,
      className,
      column,
      style,
      depth,
      col,
      wrapperComponent: Component,
      classnames: cx,
      testIdBuilder
    } = this.props;

    return (
      <Component
        rowSpan={rowSpan && rowSpan > 1 ? rowSpan : null}
        colSpan={colSpan && colSpan > 1 ? colSpan : null}
        className={cx('Table-cell', className, {
          [cx(`Table-cell-fix-${fixed}`)]: fixed,
          [`text-${column?.align}`]: column?.align,
          [`align-${column?.vAlign}`]: column?.vAlign
        })}
        style={fixed ? {position: 'sticky', zIndex, ...style} : {...style}}
        data-depth={depth || null}
        data-col={col}
        {...testIdBuilder?.getTestId()}
      >
        {children}
      </Component>
    );
  }
}

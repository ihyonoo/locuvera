import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import BrandLogo from './BrandLogo';

describe('BrandLogo', () => {
  it('is announced as the Locuvera logo', () => {
    render(<BrandLogo />);
    expect(screen.getByRole('img', { name: 'Locuvera' })).toBeInTheDocument();
  });

  it('draws the shield left half and "Locu" in the surrounding text color, the rest in brand teal', () => {
    render(<BrandLogo />);
    const fills = [...screen.getByRole('img').querySelectorAll('path')].map((p) => p.getAttribute('fill'));
    expect(fills).toEqual(['currentColor', '#0d9488']);
  });

  it('passes the class through for sizing', () => {
    render(<BrandLogo className="brand-logo" />);
    expect(screen.getByRole('img')).toHaveClass('brand-logo');
  });
});

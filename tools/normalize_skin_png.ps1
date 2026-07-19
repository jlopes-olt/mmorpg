param(
    [Parameter(Mandatory = $true)]
    [string]$Source,

    [Parameter(Mandatory = $true)]
    [string]$Output
)

Add-Type -AssemblyName System.Drawing

if (-not ('SkinAssetNormalizer' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class SkinAssetNormalizer
{
    public static void Normalize(string sourcePath, string outputPath)
    {
        const int canvasSize = 1024;
        const int targetHeight = 720;
        const int maxWidth = 820;
        const int groundY = 892;

        using (var source = new Bitmap(sourcePath))
        using (var keyed = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb))
        {
            using (var graphics = Graphics.FromImage(keyed))
            {
                graphics.DrawImageUnscaled(source, 0, 0);
            }

            var key = AverageCorners(keyed);
            RemoveKey(keyed, key);
            var bounds = FindContentBounds(keyed);
            if (bounds.Width <= 0 || bounds.Height <= 0)
                throw new InvalidOperationException("No visible subject found in " + sourcePath);

            var scale = Math.Min((double)targetHeight / bounds.Height, (double)maxWidth / bounds.Width);
            var width = Math.Max(1, (int)Math.Round(bounds.Width * scale));
            var height = Math.Max(1, (int)Math.Round(bounds.Height * scale));
            var x = (canvasSize - width) / 2;
            var y = groundY - height;

            using (var output = new Bitmap(canvasSize, canvasSize, PixelFormat.Format32bppArgb))
            using (var graphics = Graphics.FromImage(output))
            {
                graphics.Clear(Color.Transparent);
                graphics.CompositingMode = CompositingMode.SourceCopy;
                graphics.CompositingQuality = CompositingQuality.HighQuality;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.SmoothingMode = SmoothingMode.HighQuality;
                graphics.DrawImage(keyed, new Rectangle(x, y, width, height), bounds, GraphicsUnit.Pixel);

                var directory = Path.GetDirectoryName(outputPath);
                if (!String.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                output.Save(outputPath, ImageFormat.Png);
            }
        }
    }

    private static Color AverageCorners(Bitmap bitmap)
    {
        var samples = new[] {
            bitmap.GetPixel(2, 2), bitmap.GetPixel(bitmap.Width - 3, 2),
            bitmap.GetPixel(2, bitmap.Height - 3), bitmap.GetPixel(bitmap.Width - 3, bitmap.Height - 3)
        };
        var r = 0; var g = 0; var b = 0;
        foreach (var color in samples) { r += color.R; g += color.G; b += color.B; }
        return Color.FromArgb(r / 4, g / 4, b / 4);
    }

    private static void RemoveKey(Bitmap bitmap, Color key)
    {
        var rect = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
        var data = bitmap.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        var bytes = Math.Abs(data.Stride) * bitmap.Height;
        var pixels = new byte[bytes];
        Marshal.Copy(data.Scan0, pixels, 0, bytes);

        for (var y = 0; y < bitmap.Height; y++)
        {
            for (var x = 0; x < bitmap.Width; x++)
            {
                var i = y * data.Stride + x * 4;
                var b = pixels[i]; var g = pixels[i + 1]; var r = pixels[i + 2];
                var dr = r - key.R; var dg = g - key.G; var db = b - key.B;
                var distance = Math.Sqrt(dr * dr + dg * dg + db * db);

                if (distance <= 14)
                {
                    pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 0;
                    continue;
                }

                var alpha = distance >= 220 ? 1.0 : (distance - 14.0) / 206.0;
                alpha = Math.Max(0.0, Math.Min(1.0, alpha));
                if (alpha < 1.0)
                {
                    pixels[i + 2] = Unblend(r, key.R, alpha);
                    pixels[i + 1] = Unblend(g, key.G, alpha);
                    pixels[i] = Unblend(b, key.B, alpha);
                }
                pixels[i + 3] = (byte)Math.Round(alpha * 255.0);
            }
        }

        Marshal.Copy(pixels, 0, data.Scan0, bytes);
        bitmap.UnlockBits(data);
    }

    private static byte Unblend(byte value, byte key, double alpha)
    {
        if (alpha <= 0.001) return 0;
        var result = (value - (1.0 - alpha) * key) / alpha;
        return (byte)Math.Max(0, Math.Min(255, Math.Round(result)));
    }

    private static Rectangle FindContentBounds(Bitmap bitmap)
    {
        var left = bitmap.Width; var top = bitmap.Height; var right = -1; var bottom = -1;
        var rect = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
        var data = bitmap.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var bytes = Math.Abs(data.Stride) * bitmap.Height;
        var pixels = new byte[bytes];
        Marshal.Copy(data.Scan0, pixels, 0, bytes);
        bitmap.UnlockBits(data);

        for (var y = 0; y < bitmap.Height; y++)
        {
            for (var x = 0; x < bitmap.Width; x++)
            {
                // Ignore the faint chroma-key compression halo when measuring the sprite.
                if (pixels[y * data.Stride + x * 4 + 3] <= 96) continue;
                left = Math.Min(left, x); right = Math.Max(right, x);
                top = Math.Min(top, y); bottom = Math.Max(bottom, y);
            }
        }
        return right < left ? Rectangle.Empty : Rectangle.FromLTRB(left, top, right + 1, bottom + 1);
    }
}
'@ -ReferencedAssemblies System.Drawing
}

$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$outputPath = [System.IO.Path]::GetFullPath($Output)
[SkinAssetNormalizer]::Normalize($sourcePath, $outputPath)

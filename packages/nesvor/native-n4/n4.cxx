#include <itkImage.h>
#include <itkN4BiasFieldCorrectionImageFilter.h>
#include <itkShrinkImageFilter.h>
#include <itkBSplineControlPointImageFilter.h>
#include <itkMultiThreaderBase.h>
#include <cmath>
#include <cstdint>
#include <string>
#include <algorithm>

namespace {
std::string lastError;
using Image = itk::Image<float, 3>;
using Mask = itk::Image<unsigned char, 3>;
using Corrector = itk::N4BiasFieldCorrectionImageFilter<Image, Mask, Image>;
}

extern "C" const char *n4_error() {
  return lastError.c_str();
}

extern "C" int n4_correct(const float *input, const unsigned char *mask,
                          float *output, const uint32_t *shape,
                          const double *resolution, const double *options) {
  try {
    itk::MultiThreaderBase::SetGlobalDefaultNumberOfThreads(1);
    Image::SizeType size;
    Image::SpacingType spacing;
    for (unsigned int axis = 0; axis < 3; ++axis) {
      size[axis] = shape[axis];
      spacing[axis] = resolution[2 - axis];
    }
    auto image = Image::New();
    image->SetRegions(size);
    image->SetSpacing(spacing);
    image->Allocate();
    const size_t count = size[0] * size[1] * size[2];
    std::copy(input, input + count, image->GetBufferPointer());
    auto maskImage = Mask::New();
    maskImage->SetRegions(size);
    maskImage->SetSpacing(spacing);
    maskImage->Allocate();
    if (mask) {
      std::copy(mask, mask + count, maskImage->GetBufferPointer());
    } else {
      maskImage->FillBuffer(1);
    }
    Image::Pointer fittingImage = image;
    Mask::Pointer fittingMask = maskImage;
    const unsigned int shrink = static_cast<unsigned int>(options[0]);
    if (shrink > 1) {
      auto imageShrink = itk::ShrinkImageFilter<Image, Image>::New();
      imageShrink->SetInput(image);
      imageShrink->SetShrinkFactors(shrink);
      imageShrink->Update();
      fittingImage = imageShrink->GetOutput();
      fittingImage->DisconnectPipeline();
      auto maskShrink = itk::ShrinkImageFilter<Mask, Mask>::New();
      maskShrink->SetInput(maskImage);
      maskShrink->SetShrinkFactors(shrink);
      maskShrink->Update();
      fittingMask = maskShrink->GetOutput();
      fittingMask->DisconnectPipeline();
    }
    auto corrector = Corrector::New();
    corrector->SetInput(fittingImage);
    corrector->SetMaskImage(fittingMask);
    corrector->SetMaskLabel(1);
    corrector->SetBiasFieldFullWidthAtHalfMaximum(options[1]);
    corrector->SetConvergenceThreshold(options[2]);
    corrector->SetSplineOrder(static_cast<unsigned int>(options[3]));
    corrector->SetWienerFilterNoise(options[4]);
    Corrector::VariableSizeArrayType iterations;
    iterations.SetSize(static_cast<unsigned int>(options[6]));
    iterations.Fill(static_cast<unsigned int>(options[5]));
    corrector->SetMaximumNumberOfIterations(iterations);
    corrector->SetNumberOfFittingLevels(static_cast<unsigned int>(options[6]));
    Corrector::ArrayType controlPoints;
    controlPoints.Fill(static_cast<unsigned int>(options[7]));
    corrector->SetNumberOfControlPoints(controlPoints);
    corrector->SetNumberOfHistogramBins(static_cast<unsigned int>(options[8]));
    corrector->Update();
    if (shrink == 1) {
      std::copy(corrector->GetOutput()->GetBufferPointer(),
                corrector->GetOutput()->GetBufferPointer() + count, output);
    } else {
      using BiasImage = Corrector::ScalarImageType;
      using Reconstructor = itk::BSplineControlPointImageFilter<
          Corrector::BiasFieldControlPointLatticeType, BiasImage>;
      auto reconstructor = Reconstructor::New();
      reconstructor->SetInput(corrector->GetLogBiasFieldControlPointLattice());
      reconstructor->SetSplineOrder(corrector->GetSplineOrder());
      reconstructor->SetSize(image->GetLargestPossibleRegion().GetSize());
      reconstructor->SetOrigin(image->GetOrigin());
      reconstructor->SetSpacing(image->GetSpacing());
      reconstructor->SetDirection(image->GetDirection());
      reconstructor->Update();
      const auto *bias = reconstructor->GetOutput()->GetBufferPointer();
      for (size_t i = 0; i < count; ++i) {
        output[i] = input[i] / std::exp(bias[i][0]);
      }
    }
    lastError.clear();
    return 0;
  } catch (const std::exception &error) {
    lastError = error.what();
    return 1;
  }
}

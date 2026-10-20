// antsRegistration for WebAssembly: argv as the ANTs command line takes it, NIfTI images,
// MATLAB and text transforms, one ITK thread so results do not depend on the host.
#include <iostream>
#include <string>
#include <vector>
#include "antsRegistration.h"
#include "itkMatlabTransformIOFactory.h"
#include "itkMultiThreaderBase.h"
#include "itkNiftiImageIOFactory.h"
#include "itkTxtTransformIOFactory.h"

int main(int argc, char* argv[]) {
  itk::NiftiImageIOFactory::RegisterOneFactory();
  itk::MatlabTransformIOFactory::RegisterOneFactory();
  itk::TxtTransformIOFactory::RegisterOneFactory();
  itk::MultiThreaderBase::SetGlobalDefaultNumberOfThreads(1);
  itk::MultiThreaderBase::SetGlobalDefaultThreader(itk::MultiThreaderBase::ThreaderEnum::Platform);
  try {
    return ants::antsRegistration(std::vector<std::string>(argv + 1, argv + argc), nullptr);
  } catch (const std::exception& e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
}

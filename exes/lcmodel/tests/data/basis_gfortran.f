c     Driver for tests/basis_vs_gfortran.rs.  Build with the subprograms
c     SET_LSHAPE_FALSE, AREAWA, GETPHA and INTEGRATE cut from LCModel.f, a
c     stub AREAW2, and lcmodel.inc on the include path:
c       gfortran -fno-backslash -fno-f2c -O3 -fall-intrinsics -std=legacy
c         -I<source> basis_gfortran.f <extracted>.f > basis_gfortran.txt
      program drv
      include 'lcmodel.inc'
      external areawa
      complex dfa(256), dwa(256)
      real yo(256), yi(256)
      integer ks, ke, np
      n = 256
c     Synthetic phased Lorentzian doublet on a sloped baseline.
      do 10 j = 1, n
         x = float(j - 128)
         c1 = 1. / (1. + (x/4.)**2)
         d1 = (x/4.) * c1
         c2 = .4 / (1. + ((x-9.)/3.)**2)
         dfa(j) = cmplx(c1 + c2 + .001*x, d1 - .01*sin(.1*x))
         dfa(j) = dfa(j) * cexp(cmplx(0., 0.7))
         dwa(j) = dfa(j)
 10   continue
      write (*, '(a)') 'GETPHA_IN'
      write (*, '(4z9)') (dfa(j), j = 1, n)
      ks = 118
      ke = 138
      np = ke - ks + 1
      radian = 3.14159265 / 180.
      degz = 0.
      call getpha (ks, ke, dfa, dwa, n, radian, np, yo, yi, degz)
      write (*, '(a)') 'GETPHA_OUT'
      write (*, '(3i8, z9)') ks, ke, np, degz
      write (*, '(4z9)') (dwa(j), j = 1, n)
      ks = 110
      ke = 146
      ly = 128
      call integrate (dwa, .0123, rint, ke, ks, ly, n, 12)
      write (*, '(a)') 'INTEGRATE_OUT'
      write (*, '(2i8, z9)') ks, ke, rint
c     AREAWA: decaying water FID.
      nunfil = 512
      ppminc = 0.0153
      rrange = 1.e30
      nwsst = 3
      nwsend = 40
      iareaw = 1
      do 20 j = 1, nunfil
         h2ot(j) = cmplx(1000.*exp(-.013*j)*cos(.2*j),
     1                   1000.*exp(-.013*j)*sin(.2*j))
 20   continue
      write (*, '(a)') 'AREAWA_IN'
      write (*, '(4z9)') (h2ot(j), j = 1, nunfil)
      a = areawa(1)
      write (*, '(a)') 'AREAWA_OUT'
      write (*, '(z9)') a
c     SET_LSHAPE_FALSE
      ndata = 512
      nmetab = 2
      pi = 3.14159265
      fwhmst = .09
      fwhmba = .03
      deltat = 2.5e-4
      hzpppm = 123.2
      rrange = 1.e30
      do 30 j = 1, ndata
         basist(j, 2) = cmplx(cos(.05*j), sin(.03*j))
 30   continue
      write (*, "(a)") "LSHAPE_IN"
      write (*, "(4z9)") (basist(j, 2), j = 1, ndata)
      call set_lshape_false ()
      write (*, '(a)') 'LSHAPE_OUT'
      write (*, '(4z9)') (basist(j, 2), j = 1, ndata)
      end
      subroutine errmes (n, l, ch)
      character*(*) ch
      write (*, '(a, 2i5, 1x, a)') 'ERRMES', n, l, ch
      if (iabs(l) .ge. 4) stop
      end

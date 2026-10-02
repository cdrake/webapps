C  Reference driver for tests/numerics_vs_gfortran.rs. Build it against
C  DCFFT_R (LCModel.f lines 2232-2260) and everything from csft_r to the end
C  of LCModel.f (lines 12688-15516), with the flags of the native build:
C    awk 'NR>=2232&&NR<=2260' LCModel.f > ext.f
C    awk 'NR>=12688' LCModel.f >> ext.f
C    gfortran -fno-backslash -fno-f2c -O3 -std=legacy numerics_driver.f
C             ext.f -o drv && ./drv > numerics_ref.txt
C  Every REAL and DOUBLE PRECISION result is written as its bit pattern,
C  or as a hash of the bit patterns (HSHR/HSHD) for long arrays.
      PROGRAM NUMDRV
      COMPLEX DT(4096), FT(4096), FW(4096), FI(4096)
      REAL WFFTC(4*4096+15)
      COMPLEX*16 DDT(4096), DFT(4096)
      DOUBLE PRECISION DWFFTC(4*4096+15)
      INTEGER NS(28)
      DATA NS/1,2,3,4,5,6,7,8,9,10,11,12,14,15,16,25,30,49,64,77,98,
     1 120,143,210,256,1000,1024,2048/
      LWFFT = 0
      LDWFFT = 0
      DO 100 IS=1,28
         N = NS(IS)
         CALL MKDAT(DT, N)
         DO 110 J=1,N
            DDT(J) = DT(J)
  110    CONTINUE
         CALL CFFT(DT, FT, N, LWFFT, WFFTC)
         CALL PRC('CFFT', FT, N)
         CALL CFFTIN(FT, FI, N, LWFFT, WFFTC)
         CALL PRC('CFFTIN', FI, N)
         CALL CFFT_R(DT, FT, N, LWFFT, WFFTC)
         CALL PRC('CFFT_R', FT, N)
         CALL CFFTIN_R(FT, FW, FI, N, LWFFT, WFFTC)
         CALL PRC('CFFTIN_R', FI, N)
         CALL DCFFT_R(DDT, DFT, N, LDWFFT, DWFFTC)
         CALL PRZ('DCFFT_R', DFT, N)
         IF (N .LE. 64) THEN
            CALL CSFT_R(DT, FT, N)
            CALL PRC('CSFT_R', FT, N)
            CALL CSFTIN_R(FT, FW, FI, N)
            CALL PRC('CSFTIN_R', FI, N)
         END IF
  100 CONTINUE
      CALL TSEQ(100, 0, LWFFT, WFFTC)
      CALL TSEQ(256, 0, LWFFT, WFFTC)
      CALL TSEQ(256, 1, LWFFT, WFFTC)
      CALL TSEQ(2048, 1, LWFFT, WFFTC)
      CALL TRAND
      CALL TGAM
      CALL TBETA
      CALL TPNNLS(12, 5, 0)
      CALL TPNNLS(12, 5, 1)
      CALL TPNNLS(20, 8, 0)
      CALL TPNNLS(3, 5, 0)
      CALL TPNNLS(30, 12, 2)
      CALL TPNNLS(40, 20, 2)
      DO 200 N=1,9
         CALL TEIG(N, 0)
  200 CONTINUE
      CALL TEIG(5, 1)
      CALL TEIG(6, 2)
      CALL TPLOT(1)
      CALL TPLOT(2)
      CALL TPLOT(3)
      CALL TPLOT(4)
      END
C
      SUBROUTINE MKDAT(DT, N)
      COMPLEX DT(N)
      DO 110 J=1,N
         DT(J) = CMPLX(FLOAT(MOD(J*7919,1009)-504)/128.,
     1                 FLOAT(MOD(J*104729,2003)-1001)/256.)
  110 CONTINUE
      END
C
      SUBROUTINE HSHR(IH, X)
      INTEGER*8 IH, IU
      REAL X
      IU = TRANSFER(X, 0)
      IF (IU .LT. 0) IU = IU + 4294967296_8
      IH = MOD(IH*1000003_8 + IU, 2147483647_8)
      END
C
      SUBROUTINE HSHD(IH, D)
      INTEGER*8 IH, IB, IU
      DOUBLE PRECISION D
      IB = TRANSFER(D, 0_8)
      IU = IAND(IB, 4294967295_8)
      IH = MOD(IH*1000003_8 + IU, 2147483647_8)
      IU = IAND(ISHFT(IB, -32), 4294967295_8)
      IH = MOD(IH*1000003_8 + IU, 2147483647_8)
      END
C
      SUBROUTINE PRC(TAG, C, N)
      CHARACTER*(*) TAG
      COMPLEX C(N)
      INTEGER*8 IH
      IH = 0
      DO 110 J=1,N
         CALL HSHR(IH, REAL(C(J)))
         CALL HSHR(IH, AIMAG(C(J)))
  110 CONTINUE
      WRITE (*, '(A, 1X, I5, 1X, I12)') TAG, N, IH
      IF (N .GT. 16) RETURN
      DO 120 J=1,N
         WRITE (*, '(2(1X, Z8.8))') TRANSFER(REAL(C(J)), 0),
     1                               TRANSFER(AIMAG(C(J)), 0)
  120 CONTINUE
      END
C
      SUBROUTINE PRZ(TAG, C, N)
      CHARACTER*(*) TAG
      COMPLEX*16 C(N)
      INTEGER*8 IH
      IH = 0
      DO 110 J=1,N
         CALL HSHD(IH, DBLE(C(J)))
         CALL HSHD(IH, DIMAG(C(J)))
  110 CONTINUE
      WRITE (*, '(A, 1X, I5, 1X, I12)') TAG, N, IH
      IF (N .GT. 16) RETURN
      DO 120 J=1,N
         WRITE (*, '(2(1X, Z16.16))') TRANSFER(DBLE(C(J)), 0_8),
     1                                 TRANSFER(DIMAG(C(J)), 0_8)
  120 CONTINUE
      END
C
      SUBROUTINE PRR(TAG, X, N)
      CHARACTER*(*) TAG
      REAL X(N)
      INTEGER*8 IH
      IH = 0
      DO 110 J=1,N
         CALL HSHR(IH, X(J))
  110 CONTINUE
      WRITE (*, '(A, 1X, I5, 1X, I12)') TAG, N, IH
      IF (N .GT. 16) RETURN
      WRITE (*, '(8(1X, Z8.8))') (TRANSFER(X(J), 0), J=1,N)
      END
C
      SUBROUTINE PRD(TAG, X, N)
      CHARACTER*(*) TAG
      DOUBLE PRECISION X(N)
      INTEGER*8 IH
      IH = 0
      DO 110 J=1,N
         CALL HSHD(IH, X(J))
  110 CONTINUE
      WRITE (*, '(A, 1X, I5, 1X, I12)') TAG, N, IH
      IF (N .GT. 16) RETURN
      WRITE (*, '(4(1X, Z16.16))') (TRANSFER(X(J), 0_8), J=1,N)
      END
C
      SUBROUTINE TSEQ(N, ISPIKE, LWFFT, WFFTC)
      COMPLEX DT(4096), DF(8192)
      REAL WFFTC(*)
      CALL MKDAT(DT, N)
      IF (ISPIKE .NE. 0) THEN
         DO 110 J=1,N
            DT(J) = DT(J) * (FLOAT(N-J)/FLOAT(N))**4
  110    CONTINUE
         DO 120 J=N-30,N
            DT(J) = (0., 0.)
  120    CONTINUE
         DT(N-3) = (1.E-3, 2.E-3)
      END IF
      CALL SEQTOT(DT, DF, N, LWFFT, WFFTC)
      CALL PRC('SEQTOT', DT, N)
      CALL PRC('SEQTOTF', DF, 2*N)
      END
C
      SUBROUTINE TRAND
      DOUBLE PRECISION DIX
      REAL X(5000)
      DIX = 1234567.D0
      DO 110 J=1,5000
         X(J) = RANDOM(DIX)
  110 CONTINUE
      CALL PRR('RANDOM', X, 5000)
      CALL PRR('RANDOM1', X, 8)
      CALL PRD('DIX', DIX, 1)
      END
C
      SUBROUTINE TGAM
      DOUBLE PRECISION DGAMLN, G(400)
      DO 110 K=1,400
         G(K) = DGAMLN(DBLE(K)/8.D0 + DBLE(K)*1.D-3)
  110 CONTINUE
      CALL PRD('DGAMLN', G, 400)
      CALL PRD('DGAMLN1', G, 12)
      END
C
      SUBROUTINE TBETA
      REAL AB(7), Y(17), FS(6)
      DATA AB/.5, 1., 2.5, 7., 30.25, 150., 1000./
      DATA FS/.1, .5, 1., 2., 5., 20./
      DO 130 IA=1,7
         DO 120 IB=1,7
            DO 110 I=0,16
               Y(I+1) = BETAIN(FLOAT(I)/16., AB(IA), AB(IB), 6)
  110       CONTINUE
            CALL PRR('BETAIN', Y, 17)
  120    CONTINUE
  130 CONTINUE
      DO 150 IA=1,6
         DO 140 IB=1,6
            Y(IB) = FISHNI(FS(IA), 2.*AB(IB)+1., 3.*AB(IB)+.5, 6)
  140    CONTINUE
         CALL PRR('FISHNI', Y, 6)
  150 CONTINUE
      END
C
      SUBROUTINE TPNNLS(M, N, KIND)
      PARAMETER (MDA=45)
      DOUBLE PRECISION A(MDA,20), B(MDA), X(20), W(20), ZZ(MDA),
     1 DVAR, XT(20), AP(MDA*20)
      INTEGER INDEX(20)
      LOGICAL NONNEG(20)
      DO 120 J=1,N
         DO 110 I=1,M
            A(I,J) = DBLE(MOD(I*37+J*101+I*J*13, 97)-48)/16.D0
  110    CONTINUE
         NONNEG(J) = KIND.EQ.0 .OR. MOD(J,3).NE.0
         XT(J) = DBLE(MOD(J*7, 11)-4)/3.D0
  120 CONTINUE
      DO 140 I=1,M
         B(I) = DBLE(MOD(I*53,89)-44)/8.D0
         IF (KIND .EQ. 2) THEN
            B(I) = B(I)*1.D-2
            DO 130 J=1,N
               B(I) = B(I) + A(I,J)*XT(J)
  130       CONTINUE
         END IF
  140 CONTINUE
      CALL PNNLS(A, MDA, M, N, B, X, DVAR, W, ZZ, INDEX, MODE, 1.D30,
     1           NONNEG, .5D0, NSETP)
      WRITE (*, '(A, 4I5)') 'PNNLS', M, N, MODE, NSETP
      WRITE (*, '(20I4)') (INDEX(J), J=1,N)
      CALL PRD('DVAR', DVAR, 1)
      CALL PRD('X', X, N)
      CALL PRD('W', W, N)
      DO 160 J=1,N
         DO 150 I=1,M
            AP(I+(J-1)*M) = A(I,J)
  150    CONTINUE
  160 CONTINUE
      CALL PRD('A', AP, M*N)
      CALL PRD('B', B, M)
      END
C
      SUBROUTINE TEIG(N, KIND)
      PARAMETER (NM=8)
      REAL A(NM,NM), W(NM), Z(NM,NM), FV1(NM), FV2(NM)
      DO 120 J=1,NM
         DO 110 I=1,NM
            A(I,J) = FLOAT(MOD(I*J*7+I+J, 23)-11)/4.
            IF (KIND .EQ. 1) A(I,J) = 0.
            IF (KIND .EQ. 2) A(I,J) = 1./FLOAT(I+J-1)
            Z(I,J) = 0.
  110    CONTINUE
         IF (KIND .EQ. 1) A(J,J) = FLOAT(MOD(J,3))
  120 CONTINUE
      CALL EIGVRS(NM, N, A, W, Z, FV1, FV2, IERR)
      WRITE (*, '(A, 3I5)') 'EIGVRS', N, KIND, IERR
      IF (IERR .NE. 0) RETURN
      CALL PRR('W', W, N)
      CALL PRR('Z', Z, NM*N)
      END
C
      SUBROUTINE TPLOT(KIND)
      REAL X(40), Y1(40), Y2(40)
      DOUBLE PRECISION YERR(40)
      LOGICAL ONLY1, PLTERR
      N = 12
      IF (KIND .EQ. 4) N = 30
      DO 110 J=1,N
         X(J) = FLOAT(J)*.5
         Y1(J) = FLOAT(MOD(J*17, 23)-11)*.37
         Y2(J) = FLOAT(MOD(J*29, 19)-9)*.41
         YERR(J) = DBLE(MOD(J*5, 7)+1)*.123D0
  110 CONTINUE
      ONLY1 = KIND .EQ. 1 .OR. KIND .EQ. 3
      PLTERR = KIND .GE. 3
      NLINF = 0
      IF (KIND .GE. 2) NLINF = 5
      NG = 1
      MY1 = N - 1
      IF (KIND .EQ. 2) MY1 = 4
      CALL PLPRIN(X, Y1, Y2, N, ONLY1, 6, 1.E30, NLINF, NG, MY1,
     1            YERR, PLTERR)
      END
C
      SUBROUTINE ERRMES (NUMBER, ILEVEL, CHSUBP)
      CHARACTER*6 CHSUBP
      WRITE (*, '(A, 2I4, 1X, A)') 'ERRMES', NUMBER, ILEVEL, CHSUBP
      IF (IABS(ILEVEL) .GE. 4) STOP
      END

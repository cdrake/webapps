      PROGRAM T
      INCLUDE 'lcmodel.inc'
      DOUBLE PRECISION PENLTY, G, SOL(MPAR), PARNL(MNONL)
      EXTERNAL PENLTY
      K = 0
      DRANGE = 1.D30
      SDREF = 1.3D0
      NBACKG = 5
      NMETAB = 4
      DO 10 I = 1, NBACKG
         DO 10 J = 1, NBACKG
            REGB(I,J) = SNGL(G(K))
   10 CONTINUE
      DO 20 J = 1, 30
         SOL(J) = G(K)
         PARNL(J) = G(K)
   20 CONTINUE
      NREGF = 6
      NSIDE2 = 5
      DO 30 I = 1, NREGF
         DO 30 J = 1, NSIDE2
            REGF(I,J) = G(K)
   30 CONTINUE
      LRT2ST = 10
      RLRNTZ = 1.7
      DO 40 J = 1, NMETAB
         CONC_EXPECT(J) = 2. + SNGL(G(K))
         RT2MIN(J) = SNGL(G(K))
   40 CONTINUE
      IMETHD = 0
      WRITE (*,'(ES26.17E3)') PENLTY(0.37D0, 0.D0, SOL, PARNL)
      WRITE (*,'(ES26.17E3)') PENLTY(0.D0, 1.9D0, SOL, PARNL)
      WRITE (*,'(ES26.17E3)') PENLTY(0.37D0, 1.9D0, SOL, PARNL)
      IMETHD = 2
      IPOWRG = 1
      WRITE (*,'(ES26.17E3)') PENLTY(0.37D0, 1.9D0, SOL, PARNL)
      IPOWRG = 2
      WRITE (*,'(ES26.17E3)') PENLTY(0.37D0, 1.9D0, SOL, PARNL)
      WRITE (*,'(ES26.17E3)') DTERM(1), DTERM(2)
C     PASTEP
      NNONL = 12
      NLIN = 9
      LRT2ST = 5
      FSTPMQ = 0.8
      DO 50 J = 1, NLIN + NNONL
         SOLUTN(J) = G(K)
         NONNEG(J) = MOD(J, 3) .EQ. 0
   50 CONTINUE
      DO 60 J = 1, NNONL
         DPARMQ(J) = ABS(G(K)) + 0.1D0
         PAROLD(J) = G(K)
         PARNLN(J) = G(K)
   60 CONTINUE
      RSTEP = 1.
      CALL PASTEP (RSTEP)
      WRITE (*,'(ES17.9E2)') RSTEP
      DO 70 J = 1, NNONL
         WRITE (*,'(ES26.17E3)') PARNLN(J)
   70 CONTINUE
      DO 75 J = 1, NLIN + NNONL
         WRITE (*,'(L1)') NONNEG(J)
   75 CONTINUE
C     REPHAS
      LPRINT = 0
      LPHAST = 3
      NY = 50
      RADIAN = 57.29578
      PPMINC = 0.0123
      DELPPM(1) = 4.1
      PHITOT(1) = 0.3
      PHITOT(2) = -0.02
      DO 80 J = 1, NNONL
         PARBES(J,2) = G(K) * 0.1D0
   80 CONTINUE
      DO 85 J = 1, NY
         X1 = SNGL(G(K))
         X2 = SNGL(G(K))
         CY(J) = CMPLX(X1, X2)
   85 CONTINUE
      CALL REPHAS ()
      WRITE (*,'(ES17.9E2)') PHITOT(1), PHITOT(2)
      DO 90 J = 1, NY
         WRITE (*,'(ES17.9E2)') REAL(CY(J)), AIMAG(CY(J))
   90 CONTINUE
      WRITE (*,'(ES17.9E2)') REAL(CTERM(1)), AIMAG(CTERM(1))
      DO 95 J = 1, NNONL
         WRITE (*,'(ES26.17E3)') PARNLN(J)
   95 CONTINUE
C     SAVBES
      OBJECT = 12.5D0
      DSSQ = 11.25D0
      ALPHAB = 0.001D0
      ALPBPN = 0.01
      PNALPB = 3.3
      STDDEV = 0.7D0
      PMQSAV = 0.2D0
      ALPHAS = 5.D0
      CALL SAVBES (1)
      CALL SAVBES (2)
      CALL SAVBES (5)
      CALL SAVBES (-5)
      WRITE (*,'(ES26.17E3)') PENBES(1), PENBES(2), PENBES(5)
      WRITE (*,'(ES17.9E2)') SSQBES(5)
      END
      DOUBLE PRECISION FUNCTION G(K)
      K = K + 1
      G = DBLE(MOD(K*7919, 1000) - 500) / 250.D0
      END
      SUBROUTINE ERRMES (N, L, CH)
      CHARACTER*(*) CH
      WRITE (*,*) 'ERRMES', N, L, CH
      END
